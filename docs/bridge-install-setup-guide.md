# Bridge Install and Feishu Setup Guide

This guide covers the local `codex-feishu-bridge` install and the Feishu app setup needed for long-connection robot events and CardKit replies.

## 1. Install the bridge

Prerequisites:

- Node.js and npm are installed.
- `codex` is installed and works for the same user that will run the bridge.
- The checkout path is the project you want to bind by default, or you will edit `project.defaultPath` after install.
- The host can reach `open.feishu.cn` and Feishu websocket endpoints.

From the repo root:

```bash
npm install
npm run build
./install.sh --yes
```

The installer:

- installs a global `codex-feishu-bridge` package payload from the current checkout;
- writes the user systemd unit to `~/.config/systemd/user/codex-feishu-bridge.service`;
- creates `~/.config/codex-feishu-bridge/bridge.env` from `deploy/config/bridge.env.example` if missing;
- creates `~/.config/codex-feishu-bridge/config.json` from `deploy/config/config.json` if missing;
- preserves existing local config files on later runs;
- enables and restarts the user service.

Before the service can connect, fill the Feishu values in:

```bash
${EDITOR:-vim} ~/.config/codex-feishu-bridge/bridge.env
```

Required values:

```dotenv
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_BOT_OPEN_ID=ou_xxx
FEISHU_CONNECTION_MODE=websocket
BRIDGE_CONFIG_JSON=$HOME/.config/codex-feishu-bridge/config.json
```

Optional startup check:

```dotenv
FEISHU_STARTUP_NOTIFY_CHAT_ID=oc_xxx
```

Useful runtime checks:

```bash
systemctl --user status codex-feishu-bridge.service
systemctl --user cat codex-feishu-bridge.service
journalctl --user -u codex-feishu-bridge.service -n 200 --no-pager
which -a codex-feishu-bridge
```

If you update the checkout, rerun:

```bash
./install.sh --yes
```

## 2. Create the Feishu app

In the Feishu Open Platform, go to <https://open.feishu.cn/> and create an enterprise self-built app from the app console at <https://open.feishu.cn/app>.

After the app is created:

1. Open `应用能力 / 机器人 / 创建` and create the robot capability.
2. Open `应用能力 / 机器人 / 自定义机器人菜单` and configure the bot menu if you want custom entry points.
3. Open `凭证与基础信息` and copy `App ID` and `App Secret`.
4. Put those values into `FEISHU_APP_ID` and `FEISHU_APP_SECRET` in `bridge.env`.

## 3. Configure permissions

Open `开发配置 / 权限管理 / 批量导入/导出权限`.

Import a minimal bridge-oriented scope set first:

```json
{
  "scopes": {
    "tenant": [
      "cardkit:card:read",
      "cardkit:card:write",
      "im:chat:read",
      "im:message.p2p_msg:readonly",
      "im:message.group_at_msg:readonly",
      "im:message.reactions:read",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:message:update"
    ],
    "user": []
  }
}
```

Add these tenant scopes only when needed:

- `contact:contact.base:readonly`: user/contact lookup support.
- `im:message.pins:read` and `im:message.pins:write_only`: pin-related behavior.
- `im:message.reactions:write_only`: bot-authored reaction behavior.
- `im:message:recall`: bot message recall.
- `im:message:send_multi_users` and `im:message:send_sys_msg`: broadcast or system-message sends.
- `im:resource`: message resource download/upload paths.
- `docx:document:readonly`: document-reading flows.
- `application:application:self_manage`: app self-management flows.

If you need user-authorized integrations beyond the bot runtime, choose the matching user scopes from Feishu rather than importing a broad set. Examples:

- Bitable: `base:app:read`, `base:table:read`, `base:record:retrieve`, plus write scopes only if the bridge will mutate Bitable data.
- Docs/Drive: `docs:document:export`, `docx:document:readonly`, `drive:file:download`, plus write/upload scopes only if required.
- Calendar: `calendar:calendar.event:read`, plus create/update/delete scopes only if required.
- Tasks: `task:task:read`, plus write scopes only if required.
- Search: `search:docs:read` or `search:message`.
- Offline user-token flows: `offline_access`.

For the current bridge runtime, prefer tenant bot scopes. Keep user scopes out until there is a concrete user OAuth flow that needs them.

## 4. Configure events

Open `开发配置 / 事件与回调 / 事件配置 / 订阅方式` and choose `长连接`.

Open `开发配置 / 事件与回调 / 事件配置 / 添加事件`.

Required event:

| Event | Version | Key | Required permissions |
| --- | --- | --- | --- |
| 接收消息 | v2.0 | `im.message.receive_v1` | Message receive event permissions shown by Feishu during event subscription |

Recommended events:

| Event | Version | Key | Required permissions |
| --- | --- | --- | --- |
| 机器人进群 | v2.0 | `im.chat.member.bot.added_v1` | 应用身份, 获取群组信息 |
| 机器人被移出群 | v2.0 | `im.chat.member.bot.deleted_v1` | 应用身份, 获取群组信息 |

Useful optional events:

| Event | Version | Key | Required permissions |
| --- | --- | --- | --- |
| 消息已读 | v2.0 | `im.message.message_read_v1` | 应用身份, 获取单聊、群组消息 |
| 消息被reaction | v2.0 | `im.message.reaction.created_v1` | 应用身份, 获取单聊、群组消息, 查看消息表情回复 |
| 消息被取消reaction | v2.0 | `im.message.reaction.deleted_v1` | 应用身份, 获取单聊、群组消息, 查看消息表情回复 |

## 5. Configure callbacks

Open `开发配置 / 事件与回调 / 回调配置 / 订阅方式` and choose `长连接`.

Open `开发配置 / 事件与回调 / 回调配置 / 添加回调` and add:

| Callback | Key |
| --- | --- |
| 卡片回传交互 | `card.action.trigger` |

This is needed for interactive card actions such as approval and user-input controls.

## 6. Publish the app

Open `应用发布` and publish the app version after changing robot capability, permissions, events, callbacks, data permissions, or app availability.

Feishu permission and event changes usually do not affect installed tenants until the app version is published.

## 7. Get Open IDs

The bridge needs `FEISHU_BOT_OPEN_ID` so it can ignore its own messages. Use the bot's `open_id` value, not a human user's ID.

For human user Open IDs, use Feishu's official user identity docs:

- How to obtain Open ID: <https://open.feishu.cn/document/faq/trouble-shooting/how-to-obtain-openid>
- User ID concepts: <https://open.feishu.cn/document/home/user-identity-introduction/introduction>
- Obtain user ID via email or mobile number: <https://open.feishu.cn/document/server-docs/contact-v3/user/batch_get_id>

In Feishu Open Platform docs, the Chinese page title to search for is `如何获取用户的 Open ID - 开发指南 - 开发文档 - 飞书开放平台`.

If you use the email/mobile API path, make sure the app has the matching contact permissions and data permission range, then publish the app again.

## 8. Start and verify

After `bridge.env` is complete and the Feishu app is published:

```bash
systemctl --user restart codex-feishu-bridge.service
systemctl --user status codex-feishu-bridge.service
journalctl --user -u codex-feishu-bridge.service -n 200 --no-pager
```

Send the bot a DM or mention it in a group where the bot is installed.

Inside Feishu, useful bridge commands are:

- `/help`
- `/status`
- `/feishu`
- `/thread`

If `/feishu` reports websocket or outbound send failures, check:

- `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, and `FEISHU_BOT_OPEN_ID`;
- long-connection event and callback subscription mode;
- required message/card permissions;
- whether the app was published after the latest permission/event changes;
- host network/proxy settings in `bridge.env`.
