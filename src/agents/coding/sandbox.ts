import {
  SandboxObjectBase,
  type SandboxObjectConfig
} from "@dynamicagents/plugins/sandbox";
import { SANDBOX_ADAPTER, SANDBOX_INSTANCE } from "@/config";
import { INSTALL_PLAN } from "@/workspace/install-plan";
import { sandboxConfigFor } from "@/workspace/container";
import { CODING_EGRESS } from "./egress";

/**
 * `coding`'s sandbox, bound as `CODING_SANDBOX`: one container per caller per
 * repository, whose disk is the checkout the parent and its `code` sub-agents
 * share.
 *
 * Everything a sandbox does is `@dynamicagents/plugins/sandbox`'s; the config
 * below is this agent's. It runs no session — the image's daemon has one, and
 * nothing here submits to it — but it is the same image as
 * `claude-coordinator`'s, so a checkout and its install behave alike in both.
 *
 * A class of its own rather than the shared base bound directly, because a
 * Durable Object is addressed by class name: an agent needs a class, a binding
 * and a `new_sqlite_classes` entry of its own, or agents share one namespace
 * and one caller's checkout answers for all of them.
 */
export class CodingSandbox extends SandboxObjectBase<Env> {
  protected sandboxConfig(): SandboxObjectConfig {
    return sandboxConfigFor(this.env, this.ctx, {
      label: "coding-sandbox",
      adapter: SANDBOX_ADAPTER,
      instance: SANDBOX_INSTANCE,
      installPlan: INSTALL_PLAN,
      egress: {
        entrypoint: this.ctx.exports.CodingEgress,
        self: "CODING_SANDBOX",
        rules: CODING_EGRESS
      },
      backupPrefix: "coding/"
    });
  }
}
