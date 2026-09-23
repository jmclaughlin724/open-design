export interface ParsedUrl {
  protocol: string;
  hostname: string;
  href: string;
  host: string;
  pathname: string;
  searchParams: ParsedSearchParams;
  toString(): string;
}

export interface ParsedSearchParams {
  get(name: string): string | null;
  toString(): string;
}

declare const URL: {
  new (input: string, base?: string): ParsedUrl;
};

declare const URLSearchParams: {
  new (init?: Record<string, string>): ParsedSearchParams;
};

export function parseUrl(input: string, base?: string): ParsedUrl {
  return new URL(input, base);
}

export function searchParamsToString(init: Record<string, string>): string {
  return new URLSearchParams(init).toString();
}
