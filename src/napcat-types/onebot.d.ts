export interface OB11MessageSegment {
    type: string;
    data: Record<string, unknown>;
}

export interface OB11Message {
    self_id?: number;
    time: number;
    message_id: number;
    user_id: number | string;
    group_id?: number | string;
    message_type: 'private' | 'group';
    sender: {
        user_id: number | string;
        nickname: string;
    };
    message: OB11MessageSegment[] | string;
    raw_message: string;
    post_type?: string;
}
