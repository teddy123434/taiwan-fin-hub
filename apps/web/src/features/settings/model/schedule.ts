export const weekdayOptions = [
  { value: 1, label: "週一" },
  { value: 2, label: "週二" },
  { value: 3, label: "週三" },
  { value: 4, label: "週四" },
  { value: 5, label: "週五" },
  { value: 6, label: "週六" },
  { value: 0, label: "週日" },
];

export function formatScheduleWeekdays(days: number[]) {
  return `每${weekdayOptions
    .filter((option) => days.includes(option.value))
    .map((option) => option.label)
    .join("、")}`;
}
