export const MEM00_DELETE_TRIGGER: string;
export const MEM00_DELETE_SOURCE_SHA256: string;
export const MEM00_FUNCTION_AUTHORITY_SQL: string;
export function withoutAttestedMem00Trigger<T extends { tgname: string }>(rows: T[]): T[];
