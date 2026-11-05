import type { OB11Message } from 'napcat-types/napcat-onebot';

export interface PluginConfigItem {
    key: string;
    type: 'string' | 'number' | 'boolean' | 'select' | 'multi-select' | 'html' | 'text';
    label: string;
    description?: string;
    default?: unknown;
}

export type PluginConfigSchema = PluginConfigItem[];

interface NapCatConfigClass {
    text(key: string, label: string, defaultValue?: string, description?: string, reactive?: boolean): PluginConfigItem;
    number(key: string, label: string, defaultValue?: number, description?: string, reactive?: boolean): PluginConfigItem;
    boolean(key: string, label: string, defaultValue?: boolean, description?: string, reactive?: boolean): PluginConfigItem;
    html(content: string): PluginConfigItem;
    combine(...items: PluginConfigItem[]): PluginConfigSchema;
}

export interface PluginHttpRequest {
    query: Record<string, string | string[] | undefined>;
    body: unknown;
    headers: Record<string, string | string[] | undefined>;
    params: Record<string, string>;
}

export interface PluginHttpResponse {
    status(code: number): PluginHttpResponse;
    json(data: unknown): void;
}

type PluginRequestHandler = (
    request: PluginHttpRequest,
    response: PluginHttpResponse,
    next: (error?: unknown) => void,
) => void | Promise<void>;

interface PluginRouterRegistry {
    get(path: string, handler: PluginRequestHandler): void;
    post(path: string, handler: PluginRequestHandler): void;
    getNoAuth(path: string, handler: PluginRequestHandler): void;
    postNoAuth(path: string, handler: PluginRequestHandler): void;
    static(urlPath: string, localPath: string): void;
    page(page: {
        path: string;
        title: string;
        htmlFile: string;
        description?: string;
    }): void;
}

export interface PluginLogger {
    log(...args: unknown[]): void;
    debug(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
}

export type SendMessageSegment =
    | { type: 'text'; data: { text: string } }
    | { type: 'at'; data: { qq: string } }
    | { type: 'image'; data: { file: string } };

export interface SendMsgParams {
    message_type?: 'private' | 'group';
    user_id?: string;
    group_id?: string;
    message: string | SendMessageSegment[];
}

interface NapCatActionMap {
    delete_msg: {
        params: { message_id: number | string };
        result: null;
    };
    set_group_ban: {
        params: { group_id: string; user_id: string; duration: number | string };
        result: null;
    };
    send_msg: {
        params: SendMsgParams;
        result: { message_id: number; res_id?: string; forward_id?: string };
    };
    get_login_info: {
        params: Record<string, never>;
        result: { user_id: number; nickname: string };
    };
    set_friend_add_request: {
        params: { flag: string; approve?: string | boolean; remark?: string };
        result: void;
    };
    get_group_member_info: {
        params: { group_id: string; user_id: string; no_cache?: string | boolean };
        result: { nickname: string; card?: string };
    };
    get_group_info: {
        params: { group_id: string };
        result: { group_name: string };
    };
    get_group_list: {
        params: { no_cache?: string | boolean };
        result: Array<{ group_id: number; group_name: string }>;
    };
}

interface NapCatActions {
    call<Action extends keyof NapCatActionMap>(
        action: Action,
        params: NapCatActionMap[Action]['params'],
        adapterName: string,
        config: Record<string, unknown>,
    ): Promise<NapCatActionMap[Action]['result']>;
}

export interface NapCatPluginContext {
    actions: NapCatActions;
    pluginName: string;
    configPath: string;
    dataPath: string;
    NapCatConfig: NapCatConfigClass;
    adapterName: string;
    pluginManager: {
        config: Record<string, unknown> & { self_id?: number | string };
    };
    logger: PluginLogger;
    router: PluginRouterRegistry;
}

interface PluginConfigUIController {
    getCurrentConfig(): Record<string, unknown>;
}

export interface PluginModule<C = unknown> {
    plugin_init: (ctx: NapCatPluginContext) => void | Promise<void>;
    plugin_onmessage?: (ctx: NapCatPluginContext, event: OB11Message) => void | Promise<void>;
    plugin_onevent?: (ctx: NapCatPluginContext, event: unknown) => void | Promise<void>;
    plugin_cleanup?: (ctx: NapCatPluginContext) => void | Promise<void>;
    plugin_get_config?: (ctx: NapCatPluginContext) => C | Promise<C>;
    plugin_set_config?: (ctx: NapCatPluginContext, config: C) => void | Promise<void>;
    plugin_on_config_change?: (
        ctx: NapCatPluginContext,
        ui: PluginConfigUIController,
        key: string,
        value: unknown,
        currentConfig: Record<string, unknown>,
    ) => void | Promise<void>;
}
