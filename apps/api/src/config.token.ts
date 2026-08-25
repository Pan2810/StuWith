import type { ApiEnv } from '@stuwith/config';

/** Injection token for the already-validated environment. */
export const APP_CONFIG = Symbol('APP_CONFIG');

export type AppConfig = ApiEnv;
