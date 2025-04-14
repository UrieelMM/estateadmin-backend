export function normalizeMexNumber(originalNum: string): string {
  if (originalNum.startsWith('521')) {
    return '52' + originalNum.slice(3);
  }
  return originalNum;
}

export function normalizeForFirestore(input: string): string {
  let digits = input.replace(/\D/g, '');
  if (digits.length > 10) {
    digits = digits.slice(digits.length - 10);
  }
  return digits;
}
