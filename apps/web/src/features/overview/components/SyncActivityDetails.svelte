<script lang="ts">
  import type { SyncActivityDetailsPage } from "@taiwan-fin-hub/shared";
  import {
    formatCurrency,
    formatDate,
    formatDateTime,
  } from "@/shared/format/financial";
  import Button from "@/shared/ui/Button.svelte";

  let {
    page,
    loading = false,
    failed = false,
    onRetry,
  }: {
    page?: SyncActivityDetailsPage;
    loading?: boolean;
    failed?: boolean;
    onRetry: () => void;
  } = $props();
  const labels = {
    added: "新增活動",
    posted: "已入帳",
    invoice_linked: "補上發票",
  };
</script>

<div
  class="mt-2 border-t border-border/50 pt-2"
  aria-live="polite"
  aria-busy={loading}
>
  {#if loading && !page}
    <p class="text-caption text-subtle">讀取同步明細中…</p>
  {:else if failed && !page}
    <p class="text-caption text-coral">無法載入同步明細。</p>
    <Button variant="ghost" size="sm" onclick={onRetry}>重試</Button>
  {:else if page?.availability === "legacy"}
    <p class="text-caption text-subtle">此報告僅提供筆數，沒有保存活動明細。</p>
  {:else if page?.availability === "pending"}
    <p class="text-caption text-subtle">活動明細整理中，請稍後重新整理。</p>
    <Button variant="ghost" size="sm" onclick={onRetry}>重新整理</Button>
  {:else}
    {#if !page?.items.length}
      <p class="text-caption text-subtle">本次沒有新增活動、入帳或補上發票。</p>
    {:else}
      <ul class="divide-y divide-border/60">
        {#each page.items as item, index (`${index}:${item.id}`)}
          <li class="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 py-3">
            <p class="min-w-0 break-words text-sm font-medium">
              {item.title}
            </p>
            <p
              class="whitespace-nowrap text-right text-sm font-semibold tabular-nums"
            >
              {item.amount == null
                ? "—"
                : formatCurrency(item.amount, item.currency)}
            </p>
            <p class="min-w-0 break-words text-xs text-subtle">
              {item.date ? formatDate(item.date) : "日期未提供"}{item.subtitle
                ? ` · ${item.subtitle.split(" · ")[0]}`
                : ""}
            </p>
            <div class="flex flex-wrap items-start justify-end gap-1">
              {#each item.changes as change}
                <span
                  class="whitespace-nowrap rounded bg-moss/10 px-1.5 py-0.5 text-xs font-medium text-moss"
                  >{labels[change]}</span
                >
              {/each}
            </div>
            <p class="col-span-2 text-xs text-subtle">
              同步：{formatDateTime(item.syncedAt)}{item.status === "pending"
                ? " · 待入帳"
                : ""}{item.invoiceId && !item.changes.includes("invoice_linked")
                ? " · 含發票"
                : ""}
            </p>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>
