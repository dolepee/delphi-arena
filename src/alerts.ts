export async function sendAlert(title: string, detail: string): Promise<boolean> {
  const token = process.env.DELPHI_TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.DELPHI_TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return false;
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: `[Delphi Conviction ${title}]\n${detail.slice(0, 3_600)}`,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
