import { z } from 'zod';

/**
 * Shape of `GET /healthz` for both processes (apps/api and apps/realtime-gateway).
 * Declared here, not in apps/*, because AD-13 forbids contract types living in a shell.
 */
export const SERVICE_NAMES = ['api', 'realtime-gateway'] as const;

export const serviceNameSchema = z.enum(SERVICE_NAMES);
export type ServiceName = z.infer<typeof serviceNameSchema>;

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: serviceNameSchema,
  version: z.string().min(1),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
