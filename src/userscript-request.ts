export interface UserscriptResponse {
  status: number;
  responseText: string;
  finalUrl: string;
}

export interface UserscriptRequestDetails {
  method: "POST";
  url: string;
  data: FormData | string;
  anonymous: true;
  redirect: "error";
  headers: Record<string, string>;
  onload: (response: UserscriptResponse) => void;
  onerror: () => void;
  onabort: () => void;
  ontimeout: () => void;
}

export type UserscriptRequest = (details: UserscriptRequestDetails) => { abort(): void };

function requestHeaders(init: RequestInit): Record<string, string> {
  const headers: Record<string, string> = { Referer: "" };
  const source = init.headers;
  if (!source) return headers;
  if (typeof Headers !== "undefined" && source instanceof Headers) {
    source.forEach((value, name) => (headers[name] = value));
  } else if (Array.isArray(source)) {
    for (const [name, value] of source) headers[name] = value;
  } else {
    for (const [name, value] of Object.entries(source)) {
      if (typeof value === "string") headers[name] = value;
    }
  }
  return headers;
}

function requestBody(body: BodyInit | null | undefined): FormData | string {
  if (body instanceof FormData) return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (typeof body === "string") return body;
  return "";
}

// A narrow fetch adapter for Twir requests, not a general-purpose fetch replacement.
export function createUserscriptFetch(request: UserscriptRequest) {
  return (url: string, init: RequestInit): Promise<Response> =>
    new Promise((resolve, reject) => {
      const signal = init.signal;
      let handle: ReturnType<UserscriptRequest> | undefined;
      const finish = (error?: unknown, response?: Response) => {
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(response!);
      };
      const abort = () => {
        finish(signal?.reason ?? new DOMException("Request canceled.", "AbortError"));
        handle?.abort();
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      try {
        handle = request({
          method: "POST",
          url,
          data: requestBody(init.body),
          anonymous: true,
          redirect: "error",
          headers: requestHeaders(init),
          onload(response) {
            try {
              if (response.finalUrl !== url) throw new Error("Twir redirected the request.");
              // A 204/205 response cannot carry a body, and the Response
              // constructor rejects an empty string for those statuses.
              const body =
                response.status === 204 || response.status === 205 || response.status === 304
                  ? null
                  : response.responseText;
              finish(undefined, new Response(body, { status: response.status }));
            } catch (error) {
              finish(error);
            }
          },
          onerror: () => finish(new Error("The userscript manager could not connect to Twir.")),
          onabort: () => finish(new DOMException("Request canceled.", "AbortError")),
          ontimeout: () => finish(new DOMException("Request timed out.", "TimeoutError")),
        });
      } catch (error) {
        finish(error);
      }
      // anonymous/redirect enforce fetch mode in Tampermonkey, where its native
      // timeout option may be ignored. The AbortSignal above enforces our deadline.
    });
}
