/** 网页与桌面的单个气泡共用选择规则，避免状态提示遮住对话正文。 */
export function selectBubbleSlot(input: {
  workState: string | null | undefined;
  work: boolean;
  speech: boolean;
  balance: boolean;
}): 'work' | 'whisper' | 'balance' | 'none' {
  if (input.work && input.workState === 'error') return 'work';
  if (input.speech) return 'whisper';
  if (input.work && input.workState === 'success') return 'work';
  if (input.balance) return 'balance';
  return input.work ? 'work' : 'none';
}
