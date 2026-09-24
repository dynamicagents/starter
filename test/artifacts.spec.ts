import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { AGENT_CARD_PATH, TaskState } from "@a2a-js/sdk";
import {
  AGENT_ORIGIN,
  GATEKEEPER_ORIGIN,
  makeDoHelpers
} from "@dynamicagents/core/testing";
import {
  ARTIFACTS_OBJECT_NAME,
  ARTIFACT_EVENTS,
  SESSION_TRANSCRIPT_KIND,
  mintArtifactToken,
  parseArtifactPath,
  settleTranscript
} from "@dynamicagents/core/artifacts";
import type { ArtifactEntry } from "@dynamicagents/core/artifacts";
import type { RecipeExecutionRequest } from "@dynamicagents/core/subtasks";
import type { ReactiveSubagent } from "@/index";
import worker from "@/index";

/**
 * The `ARTIFACTS` wiring, end to end through this Worker.
 *
 * Core owns the object, the routes and the rule about what a thread gets, and
 * specifies all three against its own harness. What is asserted here is the
 * part core cannot reach: that *this* deployment declared the binding, exported
 * the class under the name the namespace is keyed by, applied a migration for
 * it, and put the route delegation in front of the A2A router. Every one of
 * those fails silently in a different place — at DO start, at deploy, at the
 * first request, or only when somebody opens a link — and none of them is
 * visible to a typechecker.
 *
 * The suite runs against the real binding: `vitest.config.ts` builds `env` from
 * `wrangler.jsonc`, so a spec here passing means that file declared it.
 */

const get = (path: string) =>
  worker.fetch(new Request(`${AGENT_ORIGIN}${path}`), env);

/** The deployment's one artifacts object, addressed the way the routes do. */
const artifacts = () =>
  env.ARTIFACTS.get(env.ARTIFACTS.idFromName(ARTIFACTS_OBJECT_NAME));

/**
 * The `data` payloads carried by one SSE event name, in the order they arrived.
 *
 * Frames are separated by a blank line and `data:` is the last line of each, so
 * everything past it is the JSON — the object never emits a multi-line payload,
 * because `JSON.stringify` cannot put a raw newline inside a string.
 */
const framesOf = <T>(body: string, event: string): T[] =>
  body
    .split("\n\n")
    .filter((frame) => frame.includes(`event: ${event}\n`))
    .map((frame) => JSON.parse(frame.slice(frame.indexOf("data: ") + 6)) as T);

describe("the artifact routes answer", () => {
  it("serves the viewer page on a well-formed token path", async () => {
    // A token this deployment never minted, deliberately: the page is the same
    // bytes for every artifact and is served without consulting the object, so
    // a 200 here is about the route being mounted and the binding resolving —
    // which is the whole of what this repo owns.
    const res = await get(`/a/${mintArtifactToken()}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
  });

  it("streams an artifact on the events route", async () => {
    const token = await artifacts().createArtifact("session-transcript-probe");
    await artifacts().settle(token, "completed");

    const res = await get(`/a/${token}/events`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    // Reading to the end terminates only because the artifact settled before
    // the stream opened; a live one holds the connection open by design.
    const body = await res.text();
    expect(framesOf(body, ARTIFACT_EVENTS.ready)).toEqual([
      { kind: "session-transcript-probe", status: "completed" }
    ]);
  });

  it("leaves a path it does not claim to the A2A worker", async () => {
    // Under the prefix, carrying something this package could not have minted.
    // The helper answers `null` for it rather than 404ing on the way past, so
    // it must arrive wherever an unrouted path arrives — mounting the routes
    // in front of the router must not be an act with consequences elsewhere.
    const unclaimed = await get("/a/not-a-token");
    const unrouted = await get("/no-such-path");

    expect([unclaimed.status, await unclaimed.text()]).toEqual([
      unrouted.status,
      await unrouted.text()
    ]);
  });

  it("still serves what the A2A worker routes", async () => {
    // The other half of the ordering: delegating first must shadow nothing.
    expect((await get(`/${AGENT_CARD_PATH}`)).status).toBe(200);
  });
});

const { freshStub: freshSubagent } = makeDoHelpers(
  (
    env as unknown as {
      REACTIVE_SUBAGENT: DurableObjectNamespace<ReactiveSubagent>;
    }
  ).REACTIVE_SUBAGENT
);

const TASK_ID = "task-transcript";
const ORDINAL = 2;

const PUSH = {
  taskId: TASK_ID,
  contextId: "ctx-transcript",
  pushUrl: `${GATEKEEPER_ORIGIN}/a2a/notifications`,
  pushToken: "token",
  jku: `${AGENT_ORIGIN}/.well-known/jwks.json`
};

const FIRST = "cloned the repository";
const SECOND = "the suite is green";

/**
 * A chunk that reaches a terminal failure without a model call.
 *
 * `enabled: false` is what makes it deterministic: an unusable recipe is a
 * cacheable terminal failure, and both things this spec needs — the callback
 * channel armed and the origin pinned — happen in `executeChunk` before the
 * recipe is ever validated. What is under test is what the notes do afterwards.
 */
const request = (): RecipeExecutionRequest => ({
  taskId: TASK_ID,
  subtaskId: 1,
  type: "research",
  recipe: {
    key: "research",
    version: 1,
    soul: "unused",
    toolFamilies: [],
    enabled: false,
    limits: {},
    historyWindow: 1,
    reportMetrics: false
  },
  prompt: "unused",
  references: [],
  params: {}
});

/**
 * The exchange the binding exists for: a link in the thread, the notes on the
 * transcript.
 *
 * Core decides all of it and has its own specs for the decision. This one is
 * the integration — the same rule, driven through this Worker's facet, this
 * Worker's binding and this Worker's routes, which is the only place the three
 * can disagree.
 */
describe("a subtask's notes reach the thread as one link", () => {
  it("posts the link once and records every note on the transcript", async () => {
    const posted: { text: string; key: string }[] = [];
    const stub = freshSubagent("transcript-flow");

    await runInDurableObject(stub, async (instance: ReactiveSubagent) => {
      (instance as unknown as { pushChannel: () => unknown }).pushChannel =
        () => ({
          // `true` is "the gatekeeper took it", which is what ends the posting.
          // A channel answering `false` is offered the link again on the next
          // note, so a stub that forgot to say would specify the wrong rule.
          working: async (text: string, key: string) => {
            posted.push({ text, key });
            return true;
          }
        });

      // The link is built on the origin in `PUSH.jku`. Without one there is no
      // link to build, and core posts the note verbatim instead.
      await instance.executeChunk(request(), 0, {}, AGENT_ORIGIN, {
        push: PUSH,
        ordinal: ORDINAL
      });

      const post = (
        instance as unknown as {
          postProgress: (e: { key: string; text: string }) => Promise<void>;
        }
      ).postProgress.bind(instance);
      await post({ key: "r1:0", text: FIRST });
      await post({ key: "r1:1", text: SECOND });
    });

    // One post for two notes, and it carries neither of them.
    expect(posted).toHaveLength(1);
    const link = posted[0]!.text;
    expect(link).not.toContain(FIRST);
    expect(link).not.toContain(SECOND);

    const matched = parseArtifactPath(new URL(link).pathname);
    expect(matched?.route).toBe("page");
    const token = matched!.token;

    // The same token the transcript was opened under — so the link a reader is
    // given and the artifact core filed against this task are one artifact.
    expect(await artifacts().tokenFor(SESSION_TRANSCRIPT_KIND, TASK_ID)).toBe(
      token
    );

    await settleTranscript(env, TASK_ID, TaskState.TASK_STATE_COMPLETED);

    const res = await get(`/a/${token}/events`);
    expect(res.status).toBe(200);
    const body = await res.text();

    // Both notes, in order, labelled with the branch that wrote them — the
    // attribution a thread gets in brackets, in the column a transcript has.
    const entries = framesOf<ArtifactEntry>(body, ARTIFACT_EVENTS.entry);
    expect(
      entries.map(({ sequence, label, text }) => ({
        sequence,
        label,
        text
      }))
    ).toEqual([
      { sequence: 1, label: `research ${ORDINAL}`, text: FIRST },
      { sequence: 2, label: `research ${ORDINAL}`, text: SECOND }
    ]);

    expect(framesOf(body, ARTIFACT_EVENTS.settled)).toEqual([
      { status: "completed" }
    ]);
  });
});
