import { resolve } from "node:path";
import { AgentAiResponder, type AiResponder } from "./room-ai.js";
import { RoomRoutes } from "./room-routes.js";
import { RoomService } from "./room-service.js";
import { SqliteRoomStore, type RoomStore } from "./room-store.js";
import type { RoomModelDirectory } from "./room-types.js";

const projectRoot = resolve(import.meta.dirname, "../..");
export const DEFAULT_ROOM_DATABASE = resolve(projectRoot, "data", "room.sqlite");

export interface RoomRuntime {
  readonly service: RoomService;
  readonly routes: RoomRoutes;
  close(): Promise<void>;
}

export interface RoomRuntimeOptions {
  databasePath?: string;
  inviteCode?: string;
  responder?: AiResponder;
  store?: RoomStore;
  activeCooldownMs?: number;
  /** 模型目录；使用默认 AgentAiResponder 时应传入 modelCatalog。 */
  models?: RoomModelDirectory;
}

/** 组装聊天室：首次启动时预置一个默认 AI 角色，方便直接体验。 */
export function createRoomRuntime(options: RoomRuntimeOptions = {}): RoomRuntime {
  const store = options.store ?? new SqliteRoomStore(options.databasePath ?? DEFAULT_ROOM_DATABASE);
  try {
    if (store.listCharacters().length === 0) {
      store.createCharacter({
        name: "小E",
        persona:
          "你是群里的 AI 助手小E，性格友好、机灵，偶尔幽默。擅长回答问题、总结讨论和活跃气氛。",
        replyMode: "mention",
      });
    }
    const service = new RoomService({
      store,
      responder: options.responder ?? new AgentAiResponder(),
      models: options.models,
      activeCooldownMs: options.activeCooldownMs,
    });
    const routes = new RoomRoutes({ service, inviteCode: options.inviteCode });
    return {
      service,
      routes,
      close: async () => {
        try {
          routes.closeStreams();
          await service.close();
        } finally {
          store.close();
        }
      },
    };
  } catch (error) {
    store.close();
    throw error;
  }
}
