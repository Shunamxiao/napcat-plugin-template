/** QQ 号列表文本 ↔ 数组；与后端 textToIdList 同一规则：井号起是注释，行内注释一并去掉 */
export function parseIdLines(text: string | undefined): string[] {
    return (text ?? '')
        .split('\n')
        .map((line) => line.split('#')[0].trim())
        .filter(Boolean)
}

/** 数组 → 文本，用于「配置里只有数组、没有派生文本」时的兜底显示 */
export function idListToText(list: (string | number)[] | undefined): string {
    return (list ?? []).map(String).join('\n')
}
