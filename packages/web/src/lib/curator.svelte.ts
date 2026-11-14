// Number of open items in the curator queue of the user (sidebar badge).
import { api } from "./api.ts";

class CuratorCount {
  total = $state(0);
  curates = $state(false);
  async refresh() {
    try {
      const r = await api.get<{ total: number; curates: boolean }>("/api/curator/counts");
      this.total = r.total;
      this.curates = r.curates;
    } catch {
      /* the API is optional (hive not mounted): no badge */
    }
  }
}

export const curatorCount = new CuratorCount();
