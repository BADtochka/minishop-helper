export type TopicTelegramApi = {
  sendMessage(chatId: string | number, text: string, options?: Record<string, unknown>): Promise<{ message_id: number }>;
  editMessageText(chatId: string | number, messageId: number, text: string, options?: Record<string, unknown>): Promise<unknown>;
};
export function topicOptions(messageThreadId?: number, replyToMessageId?: number): Record<string, unknown> {
  return { ...(messageThreadId === undefined ? {} : { message_thread_id: messageThreadId }), ...(replyToMessageId === undefined ? {} : { reply_parameters: { message_id: replyToMessageId } }) };
}
export function sendInTopic(api: TopicTelegramApi, chatId: string, text: string, messageThreadId?: number, replyToMessageId?: number) { return api.sendMessage(chatId, text, topicOptions(messageThreadId, replyToMessageId)); }
export function editInTopic(api: TopicTelegramApi, chatId: string, messageId: number, text: string, messageThreadId?: number, replyToMessageId?: number, options: Record<string, unknown> = {}) { return api.editMessageText(chatId, messageId, text, { ...topicOptions(messageThreadId, replyToMessageId), ...options }); }
