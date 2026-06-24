import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }
export function formatNumber(value: number, digits = 1) { return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value); }
export function formatAmount(value: number, digits = 2) { return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value); }
export function formatDate(value: string) { if (!value) return "-"; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(date); }
export function formatIssueType(value: string) { const normalized = value.trim().toUpperCase(); if (normalized === "CR") return "Change"; if (normalized === "SR") return "Request"; return value || "-"; }
