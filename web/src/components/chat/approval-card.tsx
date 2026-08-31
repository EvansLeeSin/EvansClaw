/**
 * 一次性工具审批卡片。
 *
 * 卡片只渲染 Gateway 提供的脱敏展示视图；这里不解析参数，也不参与
 * 风险判断。批准/拒绝请求的绑定字段由 Gateway 服务端恢复。
 */

import {
  CheckIcon,
  Clock3Icon,
  ShieldAlertIcon,
  XIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import type {
  ApprovalOutcome,
  ApprovalRequestView,
} from "@/lib/types";

export type ApprovalCardStatus = "pending" | ApprovalOutcome;

interface ApprovalCardProps {
  approval: ApprovalRequestView;
  status: ApprovalCardStatus;
  resolving?: boolean;
  error?: string;
  onResolve: (decision: "approve" | "deny") => void;
}

const RISK_LABELS: Record<ApprovalRequestView["risk"], string> = {
  read: "读取",
  write: "写入",
  external: "外部操作",
  destructive: "破坏性操作",
};

const STATUS_LABELS: Record<ApprovalCardStatus, string> = {
  pending: "等待确认",
  approved: "已允许",
  denied: "已拒绝",
  expired: "已过期",
  cancelled: "已取消",
};

export function ApprovalCard({
  approval,
  status,
  resolving = false,
  error,
  onResolve,
}: ApprovalCardProps) {
  const pending = status === "pending";
  const tone = pending
    ? "border-amber-500/40 bg-amber-500/5"
    : status === "approved"
      ? "border-emerald-500/30 bg-emerald-500/5"
      : "border-border bg-muted/30";

  return (
    <section
      data-approval-id={approval.approvalId}
      data-approval-status={status}
      aria-label={`工具审批：${approval.toolLabel}`}
      className={`w-full rounded-2xl border p-3.5 ${tone}`}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-full bg-background/80 p-1.5 text-amber-600 dark:text-amber-400">
          <ShieldAlertIcon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">需要确认工具操作</h2>
            <span className="rounded-full bg-background/80 px-2 py-0.5 text-[0.7rem] text-muted-foreground">
              {STATUS_LABELS[status]}
            </span>
          </div>
          <p className="mt-1 text-sm">
            <span className="font-medium">{approval.toolLabel}</span>
            <span className="text-muted-foreground">（{approval.toolName}）</span>
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5 text-[0.7rem] text-muted-foreground">
            <span className="rounded-md border bg-background/60 px-1.5 py-0.5">
              风险：{RISK_LABELS[approval.risk]}
            </span>
            <span className="rounded-md border bg-background/60 px-1.5 py-0.5">
              确认：{approval.confirmationLevel === "strong" ? "强确认" : "标准确认"}
            </span>
            <span className="rounded-md border bg-background/60 px-1.5 py-0.5">
              工具组：{approval.toolset}
            </span>
          </div>
        </div>
      </div>

      <div className="mt-3">
        <p className="mb-1 text-xs font-medium text-muted-foreground">将要使用的参数</p>
        <pre className="max-h-40 overflow-auto rounded-xl border bg-background/70 p-2.5 text-xs leading-relaxed whitespace-pre-wrap break-all">
          {approval.displayArguments}
        </pre>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {pending ? (
          <>
            <Button
              size="sm"
              onClick={() => onResolve("approve")}
              disabled={resolving}
              aria-label="允许一次"
            >
              <CheckIcon className="size-3.5" />
              {resolving ? "处理中…" : "允许一次"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onResolve("deny")}
              disabled={resolving}
              aria-label="拒绝审批"
            >
              <XIcon className="size-3.5" />
              拒绝
            </Button>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            {status === "approved" ? "本次工具调用已获准。" : `本次审批${STATUS_LABELS[status]}。`}
          </p>
        )}
        <span className="ml-auto inline-flex items-center gap-1 text-[0.7rem] text-muted-foreground">
          <Clock3Icon className="size-3" />
          {formatExpiry(approval, pending)}
        </span>
      </div>

      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

function formatExpiry(
  approval: ApprovalRequestView,
  pending: boolean,
): string {
  if (!pending) return `请求于 ${formatTime(approval.requestedAt)}`;
  const expiry = new Date(approval.expiresAt);
  const remaining = approval.expiresAt - Date.now();
  if (remaining <= 0) return "即将过期";
  return `${formatTime(expiry.getTime())} 前有效`;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}
