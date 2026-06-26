// v2 envelope + typed error model.
//
// The server always returns HTTP 200 and signals failure in-envelope via a
// non-null `error` field. `ApiError` is thrown by the transport when that
// happens so callers do not have to branch on the envelope manually.

// ---------------------------------------------------------------------------
// V2 envelope types (new — used by orval-generated transport + CPluginWebApiClient)
// ---------------------------------------------------------------------------

// * Mirrors the spec enum exactly (includes MT5Error for the v2 surface).
export type WebApiErrorCode =
  | 'Ok'
  | 'NoConnect'
  | 'Validation'
  | 'MT4Error'
  | 'Forbidden'
  | 'NotFound'
  | 'MT5Error'
  | 'Internal';

export interface PagingMeta {
  // * Opaque continuation token; pass back as ?cursor=. Null when no more items.
  nextCursor?: string | null;
  hasMore: boolean;
}

export interface ApiMeta {
  // * W3C trace id for log/trace correlation (Seq/SigNoz).
  activityId?: string | null;
  // * Present only on paginated list responses; omitted otherwise.
  paging?: PagingMeta | null;
}

// * Wire shape of the envelope `error` object. `managerCode` is the raw
//   MT4/MT5 ResultCode (string for named members, number otherwise), or null.
export interface ApiErrorBody {
  code: WebApiErrorCode;
  managerCode?: string | number | null;
  message?: string | null;
}

export interface ApiEnvelope<T> {
  data?: T | null;
  error?: ApiErrorBody | null;
  meta?: ApiMeta | null;
}

// * Thrown when the envelope carries a non-null error. Public surface is
//   { code, description, activityId } per design; managerCode/status are extras.
export class ApiError extends Error {
  readonly code: WebApiErrorCode;
  readonly description: string | undefined;
  readonly activityId: string | undefined;
  readonly managerCode: string | number | undefined;
  readonly status: number;

  constructor(body: ApiErrorBody, meta: ApiMeta | null | undefined, status: number) {
    const desc = body.message ?? undefined;
    super(desc ?? `v2 error: ${body.code}`);
    this.name = 'ApiError';
    this.code = body.code;
    this.description = desc;
    this.activityId = meta?.activityId ?? undefined;
    this.managerCode = body.managerCode ?? undefined;
    this.status = status;
  }
}
