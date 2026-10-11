<script lang="ts">
  import Checkbox from "@/shared/ui/Checkbox.svelte";
  import { weekdayOptions } from "../model/schedule";

  let {
    value,
    disabled = false,
    class: className = "",
    onchange,
  }: {
    value: number[];
    disabled?: boolean;
    class?: string;
    onchange: (days: number[]) => void;
  } = $props();
</script>

<fieldset class={`grid gap-1.5 text-sm font-medium ${className}`} {disabled}>
  <legend class="mb-1.5">執行日（可複選）</legend>
  <div class="flex flex-wrap gap-2">
    {#each weekdayOptions as option (option.value)}
      <label
        class="flex items-center gap-1.5 rounded-md border border-border px-2 py-2"
      >
        <Checkbox
          checked={value.includes(option.value)}
          disabled={disabled ||
            (value.length === 1 && value.includes(option.value))}
          onchange={() =>
            onchange(
              value.includes(option.value)
                ? value.filter((day) => day !== option.value)
                : [...value, option.value].sort((left, right) => left - right),
            )}
        />
        {option.label}
      </label>
    {/each}
  </div>
</fieldset>
