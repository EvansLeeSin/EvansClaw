import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { Static } from "typebox";
import type { ToolDefinition } from "./tool-types.js";

export const WRITE_FILE_MAX_BYTES = 128 * 1024;
const WRITE_FILE_MAX_PATH_CHARS = 512;
const WRITE_FILE_MAX_CONTENT_CHARS = 128 * 1024;

const WRITE_FILE_PARAMETERS = Type.Object({
  path: Type.String({
    minLength: 1,
    maxLength: WRITE_FILE_MAX_PATH_CHARS,
    description: "工作区内的相对文件路径，只使用 / 分隔目录。",
  }),
  content: Type.String({
    maxLength: WRITE_FILE_MAX_CONTENT_CHARS,
    description: "要写入的 UTF-8 文本内容，最多 128 KiB。",
  }),
  mode: Type.Union([
    Type.Literal("create"),
    Type.Literal("overwrite"),
  ], {
    description: "create 不覆盖已有文件；overwrite 明确允许覆盖。",
  }),
});

type WriteFileParameters = Static<typeof WRITE_FILE_PARAMETERS>;

export interface WriteFileDetails {
  path: string;
  mode: WriteFileParameters["mode"];
  bytes: number;
  created: boolean;
}

/**
 * Creates a text-only writer constrained to one operator-selected workspace.
 * The Registry supplies policy and approval; this implementation only handles
 * filesystem validation and an atomic write after the call is authorized.
 */
export function createWriteFileTool(
  workspaceRoot: string,
): ToolDefinition<typeof WRITE_FILE_PARAMETERS, WriteFileDetails> {
  const root = path.resolve(workspaceRoot);
  if (!root || root === path.parse(root).root) {
    throw new Error("write_file 工作区必须是非根目录路径。");
  }

  return {
    name: "write_file",
    label: "写入工作区文件",
    description:
      "在受限本地工作区写入 UTF-8 文本文件；必须经过用户确认，不执行文件或 Shell。",
    parameters: WRITE_FILE_PARAMETERS,
    toolset: "filesystem",
    risk: "write",
    source: "builtin",
    executionMode: "sequential",
    argumentRetention: "full",
    execute: async (params, context) => {
      assertNotAborted(context.signal);
      if (params.mode !== "create" && params.mode !== "overwrite") {
        throw new Error("写入模式必须是 create 或 overwrite。");
      }
      if (params.path.length > WRITE_FILE_MAX_PATH_CHARS) {
        throw new Error("文件路径超过长度上限。");
      }
      if (params.content.length > WRITE_FILE_MAX_CONTENT_CHARS) {
        throw new Error("文件内容超过字符数上限。");
      }
      const relativePath = validateRelativePath(params.path);
      const contentBytes = Buffer.byteLength(params.content, "utf8");
      if (contentBytes > WRITE_FILE_MAX_BYTES) {
        throw new Error("文件内容超过 128 KiB 上限。");
      }

      await ensureWorkspaceRoot(root);
      assertNotAborted(context.signal);
      const target = resolveWorkspacePath(root, relativePath);
      const parent = await validateParentPath(root, target);
      const existing = await inspectTarget(target);
      if (existing === "directory") {
        throw new Error(`目标路径不是普通文件：${relativePath}`);
      }
      if (existing === "symlink") {
        throw new Error(`拒绝写入符号链接：${relativePath}`);
      }
      if (existing === "file" && params.mode === "create") {
        throw new Error(`文件已存在；如需覆盖请明确使用 overwrite：${relativePath}`);
      }

      assertNotAborted(context.signal);
      if (params.mode === "create" && existing === "missing") {
        await createFile(
          parent,
          target,
          params.content,
          context.signal,
          relativePath,
        );
      } else {
        await replaceFile(
          parent,
          target,
          params.content,
          context.signal,
          relativePath,
        );
      }
      assertNotAborted(context.signal);

      const created = existing !== "file";
      return {
        content: [
          {
            type: "text",
            text: `已${created ? "创建" : "覆盖"}工作区文件 ${relativePath}（${contentBytes} 字节）。`,
          },
        ],
        details: {
          path: relativePath,
          mode: params.mode,
          bytes: contentBytes,
          created,
        },
      };
    },
  };
}

function validateRelativePath(value: string): string {
  if (
    value.includes("\0") ||
    value.includes("\\") ||
    value.includes(":") ||
    value.startsWith("/") ||
    path.win32.isAbsolute(value)
  ) {
    throw new Error("文件路径必须是工作区内使用 / 分隔的相对路径。");
  }

  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        WINDOWS_RESERVED_NAME.test(segment),
    )
  ) {
    throw new Error("文件路径包含空目录、.、.. 或 Windows 保留名称。");
  }
  if (
    segments.some(
      (segment) =>
        WINDOWS_INVALID_NAME_CHARACTER.test(segment) ||
        WINDOWS_INVALID_NAME_ENDING.test(segment),
    )
  ) {
    throw new Error("文件路径包含 Windows 不允许的字符或结尾。");
  }
  return segments.join("/");
}

function resolveWorkspacePath(root: string, relativePath: string): string {
  const target = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(root, target);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("文件路径越过工作区边界。");
  }
  return target;
}

async function ensureWorkspaceRoot(root: string): Promise<void> {
  try {
    const info = await lstat(root);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("write_file 工作区必须是普通目录，不能是符号链接。");
    }
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    await mkdir(root, { recursive: true });
    const info = await lstat(root);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("write_file 工作区必须是普通目录，不能是符号链接。");
    }
  }
}

async function validateParentPath(root: string, target: string): Promise<string> {
  const relativeParent = path.relative(root, path.dirname(target));
  let current = root;
  if (relativeParent !== "") {
    for (const segment of relativeParent.split(path.sep)) {
      current = path.join(current, segment);
      let info;
      try {
        info = await lstat(current);
      } catch (error) {
        if (isNotFoundError(error)) {
          throw new Error("目标文件的父目录不存在；write_file 不会自动创建目录。");
        }
        throw error;
      }
      if (info.isSymbolicLink()) {
        throw new Error("拒绝经过符号链接目录写入文件。");
      }
      if (!info.isDirectory()) {
        throw new Error("目标文件的父路径不是目录。");
      }
    }
  }
  return path.dirname(target);
}

async function inspectTarget(
  target: string,
): Promise<"missing" | "file" | "directory" | "symlink"> {
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) return "symlink";
    if (info.isDirectory()) return "directory";
    if (info.isFile()) return "file";
    throw new Error("目标路径不是普通文件。");
  } catch (error) {
    if (isNotFoundError(error)) return "missing";
    throw error;
  }
}

async function createFile(
  parent: string,
  target: string,
  content: string,
  signal: AbortSignal,
  relativePath: string,
): Promise<void> {
  const temporary = path.join(
    parent,
    `.${path.basename(target)}.${randomUUID()}.evansclaw-tmp`,
  );
  let handle: FileHandle | undefined;
  let linked = false;
  try {
    handle = await open(temporary, "wx");
    assertNotAborted(signal);
    await handle.writeFile(content, "utf8");
    assertNotAborted(signal);
    await handle.sync();
    await handle.close();
    handle = undefined;
    assertNotAborted(signal);
    // A hard link creates the destination atomically and fails if another
    // writer won the create race; unlike rename it cannot replace a target.
    await link(temporary, target);
    linked = true;
    await unlink(temporary).catch(() => undefined);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    if (!linked) await unlink(temporary).catch(() => undefined);
    if (isAbortError(error) || signal.aborted) {
      throw abortError(relativePath);
    }
    throw error;
  }
}

async function replaceFile(
  parent: string,
  target: string,
  content: string,
  signal: AbortSignal,
  relativePath: string,
): Promise<void> {
  const temporary = path.join(
    parent,
    `.${path.basename(target)}.${randomUUID()}.evansclaw-tmp`,
  );
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx");
    assertNotAborted(signal);
    await handle.writeFile(content, "utf8");
    assertNotAborted(signal);
    await handle.sync();
    await handle.close();
    handle = undefined;
    assertNotAborted(signal);
    await rename(temporary, target);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    if (isAbortError(error) || signal.aborted) {
      throw abortError(relativePath);
    }
    throw error;
  }
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("文件写入已取消。");
}

function abortError(relativePath: string): Error {
  return new Error(`文件写入已取消：${relativePath}`);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const WINDOWS_INVALID_NAME_CHARACTER = /[<>"|?*]/;
const WINDOWS_INVALID_NAME_ENDING = /[. ]$/;
