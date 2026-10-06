import { z } from "zod";

export const notificationReasonSchema = z.enum(["blocked", "review", "sign_in", "usage_limit"]);
export type NotificationReason = z.infer<typeof notificationReasonSchema>;

export const ownerNotificationSchema = z.object({
  id: z.int(),
  title: z.string(),
  body: z.string(),
  reason: notificationReasonSchema,
  taskId: z.string().nullable(),
});
export type OwnerNotification = z.infer<typeof ownerNotificationSchema>;
