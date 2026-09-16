import {
  WorkspaceObjectBase,
  type WorkspaceObjectConfig
} from "@dynamicagents/plugins/computer-host";
import { INSTALL_PLAN } from "@/workspace/install-plan";
import { gitIdentity } from "@/workspace/git-identity";

/**
 * The coder's workspace, bound as `CODER_WORKSPACE`.
 *
 * Everything this object does lives in `@dynamicagents/plugins/computer-host`
 * and is shared with `claude-coder`: one Durable Object, one container, one repository, with
 * the checkout in SQLite and `computerd` mounting it over FUSE at `/workspace`.
 * What is *this agent's* is the config below.
 *
 * The subclass exists rather than the shared class being bound directly because
 * a Durable Object is addressed by class name: an agent needs a class, a binding
 * and a `new_sqlite_classes` entry of its own, or agents share one namespace and
 * one caller's checkout answers for all of them.
 */
export class CoderWorkspaceDO extends WorkspaceObjectBase {
  protected workspaceConfig(): WorkspaceObjectConfig {
    return {
      binding: "CODER_WORKSPACE",
      label: "coder-workspace",
      installPlan: INSTALL_PLAN,
      /**
       * `direct` — the container's own network position, which is the behaviour
       * this agent has always had.
       *
       * Deliberately **not** `http-gateway`. That mode routes every outbound
       * request through a Worker `Fetcher`, and this agent has no reason to put
       * itself on that path: it holds no credential the container needs, since
       * `/repo` runs clone, fetch and push as isomorphic-git inside this object.
       * `claude-coder` is the agent that needs it, and it needs it for exactly
       * one reason — swapping a credential the container must never hold.
       */
      egress: { mode: "direct" },
      // The credential git runs under, and who a commit made on this side is
      // attributed to. Config rather than an env read because the base class
      // ships from a package that cannot name this Worker's `Env`.
      git: { token: this.env.GITHUB_TOKEN, author: gitIdentity(this.env) }
    };
  }
}
