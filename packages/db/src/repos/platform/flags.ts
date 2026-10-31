// M2-02: operator flags (`platform_flags`, one row). A missing row means every flag is off.
import { eq } from "drizzle-orm";
import type { Db } from "../../client.ts";
import { platformFlags } from "../../../schema/index.ts";
import type { Executor } from "../../tx.ts";

export function platformFlagsRepo(db: Db) {
  return {
    async agentKillSwitch(tx?: Executor): Promise<boolean> {
      const rows = await (tx ?? db)
        .select({ on: platformFlags.agentKillSwitch })
        .from(platformFlags)
        .where(eq(platformFlags.id, 1))
        .limit(1);
      return rows[0]?.on ?? false;
    },
    async setAgentKillSwitch(on: boolean, tx?: Executor): Promise<void> {
      const at = new Date();
      await (tx ?? db)
        .insert(platformFlags)
        .values({ id: 1, agentKillSwitch: on, updatedAt: at })
        .onConflictDoUpdate({ target: platformFlags.id, set: { agentKillSwitch: on, updatedAt: at } });
    },
  };
}
