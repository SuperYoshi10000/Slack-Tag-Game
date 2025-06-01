import { App, RespondArguments } from "@slack/bolt";
import { Block, ConversationsListResponse, ConversationsMembersResponse, KnownBlock, RichTextBlock, RichTextBlockElement, RichTextElement, RichTextSection, WebClient } from "@slack/web-api";
import { Channel } from "@slack/web-api/dist/types/response/ConversationsListResponse";
import { Member, UsersListResponse } from "@slack/web-api/dist/types/response/UsersListResponse";
import "dotenv/config";

const PAGE_SIZE = process.env.PAGE_SIZE ? parseInt(process.env.PAGE_SIZE) : 500;
const PAGE_LIMIT = process.env.PAGE_LIMIT ? parseInt(process.env.PAGE_LIMIT) : 10;

const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    clientId: process.env.SLACK_CLIENT_ID,
    clientSecret: process.env.SLACK_CLIENT_SECRET,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
});

(async () => {
    // Start your app
    await app.start(process.env.PORT || 3000);
    console.log("⚡️ Bolt app is running!");
})();

async function getAllMembers(client: WebClient, presence?: string) {
    let res: UsersListResponse;
    const allMembers: Member[] = [];
    let cursor: string | undefined;
    let count = 0;
    do {
        res = await client.users.list({cursor, limit: PAGE_SIZE});
        if (!res.ok) throw new Error(`Error fetching members: ${res.error}`);
        const members = res.members?.filter(user => user);
        if (!members) throw new Error(`No members found`);
        allMembers.push(...members);
        cursor = res.response_metadata?.next_cursor;
        count++;
        if (count >= PAGE_LIMIT) throw new Error(`Too many pages`);
    } while (cursor);
    if (presence) {
        // Slack API limits presence requests to 50 members per minute
        if (allMembers.length > 50) throw new Error(`Too many members to filter by presence`);
        for (const member of allMembers) {
            const user = await client.users.getPresence({user: member.id});
            if (!user.ok) throw new Error(`Error fetching presence for user ${member.id}: ${user.error}`);
            if (user.presence !== presence) {
                allMembers.splice(allMembers.indexOf(member), 1);
            }
        }
    }
    return allMembers;
}

app.command("/list-users", async ({command, client, ack, respond}) => {
    await ack();
    if (!command.text) {}
    const args = command.text.split(" ");
    const requireAll = args[0] === "all";
    if (requireAll) args.shift();
    const presence = args[0] === "active" ? "active" : args[0] === "away" ? "away" : undefined;
    if (presence) args.shift();
    const filters = args[0].startsWith("filter=") ? args[0].split(":")[1].split(",").map(f => "is_" + f) : [];
    if (filters.length > 0) args.shift();
    const channels = args.map(channel => channel.replace(/<|>/g, ""));
    const allUsers = await Promise.allSettled(channels.map(async channel => {
        let res: ConversationsMembersResponse;
        let users: string[] = [];
        let cursor: string | undefined;
        let count = 0;
        do {
            res = await client.conversations.members({channel, cursor, limit: PAGE_SIZE});
            if (!res.ok) throw new Error(`Error fetching members for channel ${channel}: ${res.error}`);
            const members = res.members?.filter(user => user);
            if (!members) throw new Error(`No members found for channel ${channel}`);
            users.push(...members.map(user => `<@${user}>`));
            cursor = res.response_metadata?.next_cursor;
            count++;
            if (count >= PAGE_LIMIT) throw new Error(`Too many pages for channel ${channel}`);
        } while (cursor);
        return users;
    })).then(results => results.filter(result => result.status === "fulfilled").map(result => result.value));
    if (requireAll) {
        const allUsersFlat = allUsers.flat();
        let users = allUsersFlat
            .filter((user, i) => user && allUsersFlat.indexOf(user) == i && allUsers.every(users => !users || users.includes(user)))
            .map(user => `<@${user}>`);
        if (!users) {
            await respond("No users found.");
            return;
        }
        if (filters.length > 0) {
            let allMembers = await getAllMembers(client);
            users = users.filter(user => {
                const member = allMembers.find(member => member.id === user.replace(/<|>/g, ""));
                if (!member) return true;

                return filters.every(filter => filter.startsWith('!') ? !member.profile?.[filter.slice(1)] : member.profile?.[filter]);
            })
        }
        await respond(`All users: ${users}`);
    } else {
        let users = allUsers
            .filter((user, i) => user && allUsers.indexOf(user) == i)
            .map(user => `<@${user}>`);
        if (!users) {
            await respond("No users found.");
            return;
        }
        if (filters.length > 0) {
            let allMembers = await getAllMembers(client);
            users = users.filter(user => {
                const member = allMembers.find(member => member.id === user.replace(/<|>/g, ""));
                if (!member) return true;
                return filters.every(filter => filter.startsWith('!') ? !member.profile?.[filter.slice(1)] : member.profile?.[filter]);
            })
        }

        const userBlocks: RichTextSection[] = users.map(user => ({
            type: "rich_text_section",
            elements: [{
                type: "text",
                text: user,
            }],
        }));

        const blocks: KnownBlock[] = [{
            type: "header",
            text: {
                type: "plain_text",
                text: `Users in ${requireAll ? "all" : "any"} of: ${channels.join(", ")}`,
            }
        }, {
            type: "rich_text",
            elements: [{
                type: "rich_text_list",
                elements: userBlocks,
                style: "bullet",
            }],
        }];

        await respond({ blocks });
    }
});

app.command("/list-channels", async ({command, client, ack, respond}) => {
    await ack();
    if (!command.text) {}
    const args = command.text.split(" ");
    const requireAll = args[0] === "all";
    if (requireAll) args.shift();
    const exclude_archived = args[0] === "exclude-archived";
    if (exclude_archived) args.shift();
    const filters = args[0].startsWith("filter=") ? args[0].split(":")[1].split(",").map(f => "is_" + f.replaceAll("-", "_")) : [];
    if (filters.length > 0) args.shift();
    const users = args.slice(1).map(user => user.replace(/<|>/g, ""));
    const allChannels = await (async user => {
        let res: ConversationsListResponse;
        let channels: Channel[] = [];
        let cursor: string | undefined;
        let count = 0;
        do {
            res = await client.conversations.list({cursor, limit: PAGE_SIZE, exclude_archived});
            if (!res.ok) throw new Error(`Error fetching channels for user ${user}: ${res.error}`);
            channels.push(...(res.channels ?? []));
            cursor = res.response_metadata?.next_cursor;
            count++;
            if (count >= PAGE_LIMIT) throw new Error(`Too many pages for user ${user}`);
        } while (cursor);
        return channels;
    })();
    
    const channelBlocks: RichTextSection[] = allChannels.filter(channel => true).map(channel => ({
        type: "rich_text_section",
        elements: [{
            type: "text",
            text: `<#${channel.id}>`
        }],
    }));

    const blocks: KnownBlock[] = [{
        type: "header",
        text: {
            type: "plain_text",
            text: "Channels",
        }
    }, {
        type: "rich_text",
        elements: [{
            type: "rich_text_list",
            elements: channelBlocks,
            style: "bullet",
        }],
    }];

    await respond({ blocks });
});

app.command(/\/mkt-send(bk|md)(-temp)?/, async ({command, client, ack, respond}) => {
    await ack();
    if (!command.text) {
        await respond("No text provided.");
        return;
    }
    
    let message: string | Block[];

    switch (command.command) {
        case "/mkt-sendmd":
        case "/mkt-sendmd-temp":
            message = command.text;
            break;
        case "/mkt-sendbk":
        case "/mkt-sendbk-temp":
            const text = command.text;
            let blocks: string | Block | Block[];
            if (
                (text.startsWith("{") && text.endsWith("}")) ||
                (text.startsWith("[") && text.endsWith("]")) ||
                (text.startsWith('"') && text.endsWith('"'))
            ) { // Object, array, or string
                // Attempt to parse the text as JSON
                try {
                    blocks = JSON.parse(text);
                } catch (e) {
                    blocks = text; // Fallback to plain text if JSON parsing fails
                }
            } else { // Number, boolean, or plain text
                blocks = command.text; // Fallback to plain text if JSON parsing fails
            }
            message = typeof blocks === "string" || Array.isArray(blocks) ? blocks : [blocks];
            break;
        default:
            await respond("Unknown command.");
            return;
    }

    if (command.command.endsWith("-temp")) {
        client.chat.postEphemeral({
            channel: command.channel_id,
            user: command.user_id,
            ...(typeof message === "string" ? { text: message } : { blocks: message })
        })
    } else {
        client.chat.postMessage({
            channel: command.channel_id,
            ...(typeof message === "string" ? { text: message } : { blocks: message })
        })
    }
});

app.event("app_mention", async ({event, client, say}) => {
    if (!event.text) {
        await say("No text provided.");
        return;
    }

    await say(`You mentioned me with the following text: ${event.text}`);
});
app.event("link_shared", async ({event, client, say}) => {
});
app.event("message.groups", async ({event, client}) => {
    let messageEvent = event as MessageEvent;
    
});