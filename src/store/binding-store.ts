import fs from "node:fs/promises";
import path from "node:path";
import { SessionBinding } from "../types/domain.js";

interface StoreShape {
  bindings: SessionBinding[];
}

export class BindingStore {
  constructor(private readonly filePath: string) {}

  async get(conversationKey: string): Promise<SessionBinding | undefined> {
    const data = await this.read();
    return data.bindings.find((item) => item.conversationKey === conversationKey);
  }

  async put(binding: SessionBinding): Promise<void> {
    const data = await this.read();
    const idx = data.bindings.findIndex((item) => item.conversationKey === binding.conversationKey);
    if (idx >= 0) data.bindings[idx] = binding;
    else data.bindings.push(binding);
    await this.write(data);
  }

  async list(): Promise<SessionBinding[]> {
    const data = await this.read();
    return data.bindings;
  }

  async deleteProject(project: string): Promise<number> {
    const data = await this.read();
    const before = data.bindings.length;
    data.bindings = data.bindings.filter((item) => item.project !== project);
    const removed = before - data.bindings.length;
    if (removed > 0) {
      await this.write(data);
    }
    return removed;
  }

  private async read(): Promise<StoreShape> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as {
        bindings?: Array<{
          conversationKey: string;
          codexSessionId?: string;
          workspace?: string;
          project?: string;
          searchEnabled?: boolean;
          profile?: string;
          planMode?: "default" | "plan";
          createdAt?: string;
          updatedAt?: string;
        }>;
      };
      return {
        bindings: (parsed.bindings || [])
          .filter((item) => item.conversationKey && (item.project || item.workspace))
          .map((item) => ({
            conversationKey: item.conversationKey,
            codexSessionId: item.codexSessionId,
            project: item.project || item.workspace || "",
            searchEnabled: item.searchEnabled,
            profile: item.profile,
            planMode: item.planMode,
            createdAt: item.createdAt || new Date(0).toISOString(),
            updatedAt: item.updatedAt || item.createdAt || new Date(0).toISOString()
          }))
      };
    } catch (error) {
      return { bindings: [] };
    }
  }

  private async write(data: StoreShape): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
  }
}
