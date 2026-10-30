export interface TelegramBusinessConnection {
  readonly id: string; readonly enabled: boolean; readonly can_reply: boolean; readonly telegram_user_id: number;
}
export interface TelegramStatus {
  readonly configured: boolean; readonly id: string | null; readonly version: number | null;
  readonly bot_username: string | null; readonly bot_name: string | null; readonly business_capable: boolean;
  readonly enabled: boolean; readonly auto_reply: boolean; readonly owner_telegram_id: number | null;
  readonly provider_id: string | null; readonly model: string | null; readonly instructions: string;
  readonly last_polled_at: string | null; readonly last_error_code: string | null;
  readonly connections: readonly TelegramBusinessConnection[];
}
export interface TelegramSettingsPatch {
  readonly version: number; readonly auto_reply?: boolean; readonly enabled?: boolean; readonly instructions?: string;
  readonly provider_id?: string | null; readonly model?: string | null;
}
export interface TelegramBusinessMessage {
  readonly id: string; readonly version: number; readonly business_connection_id: string; readonly chat_id: number;
  readonly telegram_message_id: number; readonly sender_id: number | null; readonly chat_title: string;
  readonly text: string; readonly sent_at: string; readonly direction: string; readonly draft_text: string | null;
  readonly draft_status: string; readonly draft_error_code: string | null; readonly deleted_at: string | null;
}
