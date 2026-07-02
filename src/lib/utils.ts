import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }
export function formatNumber(value: number, digits = 1) { return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value); }
export function formatAmount(value: number, digits = 2) { return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value); }
export function formatDate(value: string) { if (!value) return "-"; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(date); }
export function formatDateTime(value: string | Date) {
  if (!value) return "-";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : new Intl.DateTimeFormat("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
        timeZone: "Asia/Bangkok",
      }).format(date);
}
export function dateTimeInputValue(value: string, fallbackHour = 9) {
  const raw = value.trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T${String(fallbackHour).padStart(2, "0")}:00:00`;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZone: "Asia/Bangkok",
  }).formatToParts(date).reduce<Record<string, string>>((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}
export function normalizeDateTime(value: string, fallbackHour = 9) {
  const raw = value.trim();
  if (!raw) return "";
  const dateOnly = raw.match(/^(\d{4}-\d{2}-\d{2})$/);
  const minuteOnly = raw.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})$/);
  const secondOnly = raw.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})$/);
  const normalized = dateOnly
    ? `${dateOnly[1]}T${String(fallbackHour).padStart(2, "0")}:00:00+07:00`
    : minuteOnly
      ? `${minuteOnly[1]}:00+07:00`
      : secondOnly
        ? `${secondOnly[1]}+07:00`
        : raw;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? raw : date.toISOString();
}
export function formatIssueType(value: string) { const normalized = value.trim().toUpperCase(); if (normalized === "CR") return "Change"; if (normalized === "SR") return "Request"; return value || "-"; }
