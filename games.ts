import { App, BlockElementAction, ButtonClick, InteractiveAction, InteractiveButtonClick } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { MessageEvent, ActionsBlockElement, KnownBlock } from "@slack/types";
import "dotenv/config";
import * as fs from "fs";


const SCORE_NON_TARGET = 1; // Points for not being the target
const SCORE_TARGET = -5; // Points for being the target
const TIME_MULTIPLIER_TAGGED = -0.1; // Multiplier for time-based scoring
const TIME_MULTIPLIER_TAGGER = 0.1; // Multiplier for time-based scoring in general
const AUTOSAVE_INTERVAL = 30000; // Autosave interval in milliseconds
const SCORE_INTERVAL = 60000; // Score update interval in milliseconds

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

type SendMessageFunction = (text: string, userId: string, client: WebClient, permanent?: boolean) => Promise<unknown>;

let game: TagGame;
class TagGame {
    players: Set<string> = new Set();
    in: Map<string, number> = new Map(); // Players who are currently in
    out: Map<string, number> = new Map();; // Players who are currently out
    host: string | null = null;
    active: boolean = false;
    channel?: string;
    target: string;
    lastActionTimestamp: number = Date.now(); // Initialize with the current timestamp

    constructor(channel?: string) {
        this.channel = channel;
    }
    start(startingPlayer: string) {
        this.host = startingPlayer;
        this.active = true;
        this.target = startingPlayer; // The starting player is the initial target
        this.lastActionTimestamp = Date.now();
        this.save();
    }
    join(player: string) {
        this.players.add(player);
        this.save();
    }
    leave(player: string) {
        if (this.target === player) {
            return false; // Prevent leaving if the player is currently the target
        }
        if (!this.players.has(player)) {
            return false; // Player was not in the game 
        }
        this.players.delete(player);
        if (this.players.size === 0) {
            this.stop();
        }
        return true; // Successfully left the game
    }
    stop() {
        this.players.clear();
        this.host = null;
        this.active = false;
        this.save();
    }
    save() {
        // Old code
        /*
        const gameData = {
            players: Array.from(this.players.entries()),
            in: Array.from(this.in.entries()),
            target: this.target,
            lastActionTimestamp: this.lastActionTimestamp,
        };
        // Save gameData to a database or file
        fs.writeFile("gameData.json", JSON.stringify(gameData, null, 2), (err) => {
            if (err) {
                console.error("Error saving game data:", err);
            } else {
                console.log("Game data saved successfully.");
            }
        });*/
    }
    static load() {
        game = new TagGame();
        // Old code
        /*
        // Load game data from a database or file
        if (fs.existsSync("gameData.json")) {
            fs.readFile("gameData.json", "utf8", (err, data) => {
                if (err) {
                    console.error("Error loading game data:", err);
                    return;
                }
                const gameData = JSON.parse(data);
                // Restore game state
                game.players = new Set(gameData.players);
                game.scores = new Map(gameData.scores);
                game.target = gameData.target;
                game.lastActionTimestamp = gameData.lastActionTimestamp;
            });
        }*/
    }
};

const MAX_USER_INVITE_COUNT = 10;
app.command("/tag-game", async ({ command, ack, say, client }) => {
    let action = command.text.split(" ")[0].trim().toLowerCase();
    await ack();
    const userId = command.user_id;

    switch (command.text.split(" ")[0].trim().toLowerCase()) {
        case "start":
            await startGame(userId, client, say);
            break;
        case "join":
            await joinGame(userId, client, say);
            break;
        case "leave":
            await leaveGame(userId, client, say);
            break;
        case "stop":
            await stopGame(userId, client, say);
            break;
        case "invite":
            let selectedUsers: string[] = command.text.split(" ").slice(1).map(user => user.replace(/^<@|[|>].*$/g, ""));
            if (selectedUsers.length === 0) {
                console.log(`Player "${userId}" is inviting others to the game`);
                await client.chat.postEphemeral({
                    user: userId,
                    channel: command.channel_id,
                    blocks: getInviteMenuContent().concat([{
                        type: "actions",
                        elements: [{
                            type: "button",
                            text: {
                                type: "plain_text",
                                text: "Invite People",
                                emoji: true
                            },
                            action_id: "invite_people_confirm",
                            style: "primary"
                        }, {
                            type: "button",
                            text: {
                                type: "plain_text",
                                text: "Cancel",
                                emoji: true
                            },
                            action_id: "cancel_invite_action",
                            style: "danger"
                        }]
                    }]),
                    text: "Invite people to play tag"
                });
            } else if (selectedUsers.length > MAX_USER_INVITE_COUNT) await say(`You can only invite up to ${MAX_USER_INVITE_COUNT} users at a time.`);
            else await invitePeopleToPlay(userId, selectedUsers, client, say);
            break;
    }


});

app.command("/tag-tag", async ({ command, ack, say, client }) => {
    ack();
    const userId = command.user_id;
    const tagTarget = command.text.trim().replace(/^<@|[|>].*$/g, "");
    await tagAnotherPlayer(userId, tagTarget, client, say);
});

// Score points whenever a message is sent in any channel
// This is a simple scoring system where each player gets 1 point for not being the target and -5 points for being the target
app.event("message", async ({ event }) => {
    const messageEvent = event as unknown as MessageEvent;
    if (messageEvent.channel_type !== "channel") return; // Only process messages in public channels
    if (messageEvent.subtype) return; // Only process regular messages, not subtypes
    if (game) for (const player of game.players) {
        game.scores.set(player, Math.max((game.scores.get(player) || 0) + (player === game.target ? SCORE_TARGET : SCORE_NON_TARGET), 0));
    }
});

app.event("app_home_opened", ({ event, client }) => showHomeView(event.user, client));

function getInviteMenuContent(): KnownBlock[] {
    return [{
        block_id: "invite_people_to_play",
        type: "input",
        element: {
            type: "multi_users_select",
            placeholder: {
                type: "plain_text",
                text: "Select users",
                emoji: true
            },
            action_id: "invite_people_to_play",
        },
        label: {
            type: "plain_text",
            text: "Invite people to play",
            emoji: true
        }
    }];
}

// Helper functions for each action

async function startGame(userId: string, client: WebClient, reply: SendMessageFunction) {
    console.log(`Player "${userId}" is starting a game`);
    if (game?.active) {
        await reply("A game is already in progress.", userId, client);
        return;
    }
    TagGame.load();
    game.start(userId);
    await showHomeView(userId, client);
}

async function joinGame(userId: string, client: WebClient, reply: SendMessageFunction) {
    console.log(`Player "${userId}" is joining the game`);
    if (!game) {
        await reply("No game is currently in progress. Please start a game first.", userId, client);
        return;
    }
    if (!game.players.has(userId)) {
        game.join(userId);
    } else {
        await reply("You are already in the game.", userId, client);
    }
    await showHomeView(userId, client);
}

async function stopGame(userId: string, client: WebClient, reply: SendMessageFunction) {
    console.log(`Player "${userId}" is stopping the game`);
    if (!game) {
        await reply("No game is currently in progress.", userId, client);
        return;
    }
    if (userId !== game.host) {
        await reply("Only the game host can stop the game.", userId, client);
        return;
    }
    game.stop();
    await showHomeView(userId, client);
    await reply("The game has been stopped.", userId, client);
}

async function leaveGame(userId: string, client: WebClient, reply: SendMessageFunction) {
    console.log(`Player "${userId}" leaving the game`);
    if (!game) {
        await reply("No game is currently in progress.", userId, client);
        return;
    }
    if (!game.players.has(userId)) {
        await reply("You are not in the game.", userId, client);
        return;
    }
    if (!game.leave(userId)) {
        await reply("You cannot leave the game because you are it.", userId, client);
        return;
    }
    await showHomeView(userId, client);
    await reply("You have left the game.", userId, client);
}

async function tagAnotherPlayer(userId: string, tagTarget: string | null, client: WebClient, reply: SendMessageFunction) {
    console.log(`Player "${userId}" is tagging "${tagTarget}"`);
    if (!game) {
        await reply("No game is currently in progress. Please start a game first.", userId, client);
        return;
    }
    if (!tagTarget) {
        await reply("Please specify a player to tag.", userId, client);
        return;
    }
    if (!game.players.has(userId)) {
        await reply("You are not a player in this game. Please join the game first.", userId, client);
        return;
    }
    if (!(userId === game.target)) {
        await reply("You can only tag while you are it.", userId, client);
        return;
    }
    if (!game.players.has(tagTarget) || !game.in.has(tagTarget)) {
        await reply("You can only tag players in the game.", userId, client);
        return;
    }
    if (userId === tagTarget) {
        await reply("You cannot tag yourself.", userId, client);
        return;
    }
    
    let lastActionTimestamp = game.lastActionTimestamp;
    let currentTime = Date.now();
    let timeSinceLastAction = Math.floor((currentTime - lastActionTimestamp) / 5);
    if (timeSinceLastAction < 5) { // 5 seconds cooldown
        await reply(`You must wait at least 5 seconds before tagging again. Time since last action: ${timeSinceLastAction} seconds.`, userId, client);
        return;
    }

    // Tag the target player
    game.target = tagTarget;
    game.out.push(tagTarget);
    game.in.delete(tagTarget);
    await reply(`<@${userId}> has tagged <@${tagTarget}>!`);
    
    game.lastActionTimestamp = currentTime; // Update the last action timestamp
    //game.scores.set(userId, Math.max((game.scores.get(userId) || 0) + Math.floor(timeSinceLastAction * TIME_MULTIPLIER_TAGGER), 0));
    //game.scores.set(tagTarget, Math.max((game.scores.get(tagTarget) || 0) + Math.floor(timeSinceLastAction * TIME_MULTIPLIER_TAGGED), 0));
    game.save();
    await showHomeView(userId, client);
}

async function invitePeopleToPlay(userId: string, selectedUsers: string[], client: WebClient, reply: SendMessageFunction) {
    console.log(`Player "${userId}" is inviting ${selectedUsers.length} user(s) to play tag`);
    await reply(`You have invited ${selectedUsers.length} user(s) to play tag.`, userId, client);
    for (const invitedUser of selectedUsers) {
        reply(`You have been invited to play tag by <@${userId}>!`, invitedUser, client); // No await here, we want to send all invites in parallel
    }
}

// Slack action handlers

app.action("start_game_action", async ({ body, ack, client }) => {
    await ack();
    const userId = body.user.id;
    await startGame(userId, client, sendMessage);
});

app.action("join_game_action", async ({ body, ack, client }) => {
    await ack();
    const userId = body.user.id;
    await joinGame(userId, client, sendMessage);
});

app.action("stop_game_action", async ({ body, ack, client }) => {
    await ack();
    const userId = body.user.id;
    await stopGame(userId, client, sendMessage);
});

app.action("leave_game_action", async ({ body, ack, client }) => {
    await ack();
    const userId = body.user.id;
    await leaveGame(userId, client, sendMessage);
});

app.action("tag_another_player", async ({ body, ack, client }) => {
    await ack();
    const userId = body.user.id;
    const tagTarget = body.type === "block_actions" && body.actions[0].type === "users_select" ? body.actions[0].selected_user : null;
    await tagAnotherPlayer(userId, tagTarget, client, sendMessage);
});

app.action("invite_people_menu", async ({ body, ack, client, action, payload }) => {
    await ack();
    const triggerId = body.type === "block_actions" ? body.trigger_id : null;
    if (triggerId) {
        await client.views.open({
            trigger_id: triggerId,
            view: {
                type: "modal",
                callback_id: "invite_people_modal",
                title: {
                    type: "plain_text",
                    text: "Invite People",
                    emoji: true
                },
                blocks: getInviteMenuContent(),
                submit: {
                    type: "plain_text",
                    text: "Invite",
                    emoji: true
                },
                close: {
                    type: "plain_text",
                    text: "Cancel",
                    emoji: true
                }
            }
        });
    }
});
app.view("invite_people_modal", async ({ ack, view, body, client }) => {
    await ack();
    const userId = body.user.id;
    const selectedUsers = view.state.values.invite_people_to_play.invite_people_to_play.selected_users || [];
    if (selectedUsers.length > MAX_USER_INVITE_COUNT) {
        await sendMessage(`You can only invite up to ${MAX_USER_INVITE_COUNT} users at a time.`, userId, client);
    } else {
        await invitePeopleToPlay(userId, selectedUsers, client, sendMessage);
    }
});

app.action("invite_people_confirm", async ({ body, ack, client, respond }) => {
    console.log(`Player "${body.user.id}" is inviting people to play`);
    await ack();
    const userId = body.user.id;
    const selectedUsers = body.type === "block_actions" && body.actions[0].type === "multi_users_select" ? body.actions[0].selected_users : [];
    respond({ delete_original: true, }); // Delete the original message
    await invitePeopleToPlay(userId, selectedUsers, client, sendMessage);
});
app.action("cancel_invite_action", async ({ ack, body, respond }) => {
    await ack();
    const userId = body.user.id;
    // Remove the invite menu
    respond({ delete_original: true, });
});


app.shortcut("tag_this_person", async ({ shortcut, ack, client }) => {
    await ack();
    const userId = shortcut.user.id;
    const tagTarget = shortcut.type === "message_action" && shortcut.message.user || null;
    await tagAnotherPlayer(userId, tagTarget, client, sendMessage);
});

setInterval(() => {
    if (game && game.active) {
        game.save();
    }
}, AUTOSAVE_INTERVAL);

async function sendMessage(text: string, userId: string, client: WebClient, permanent = false) {
    if (permanent) await client.chat.postMessage({
        channel: userId,
        text,
    }); else await client.chat.postEphemeral({
        channel: userId,
        text,
        user: userId,
    });
}

async function showHomeView(userId: string, client: WebClient) {
    const elements = Array.from(game.players.entries() || []).sort((a, b) => b[1] - a[1]).map(([player, score]) => ({
        type: "rich_text_section" as const,
        elements: [{
            type: "user" as const,
            user_id: player
        }, {
            type: "text" as const,
            text: " - "
        }, {
            type: "text" as const,
            text: score.toString(),
            style: { bold: true }
        }]
    }));

    const isPlaying = game?.players.has(userId);
    const isActive = isPlaying && game?.active;

    const buttons: ActionsBlockElement[] = [];
    if (!isActive) buttons.push({
        type: "button",
        text: {
            type: "plain_text",
            text: isPlaying ? "Leave Game" : "Join Game",
            emoji: true,
        },
        value: isPlaying ? "leave_game" : "join_game",
        action_id: isPlaying ? "leave_game_action" : "join_game_action",
        style: isPlaying ? undefined : "primary",
    });
    if (isPlaying) buttons.push({
        type: "button",
        text: {
            type: "plain_text",
            text: isActive ? "Stop Game" : "Start Game",
            emoji: true
        },
        value: isActive ? "stop_game" : "start_game",
        action_id: isActive ? "stop_game_action" : "start_game_action",
        style: isActive ? "danger" : "primary"
    });
    buttons.push({
        type: "button",
        text: {
            type: "plain_text",
            text: "Invite People",
            emoji: true
        },
        value: "invite_people",
        action_id: "invite_people_menu",
    });
    

    const blocks: KnownBlock[] = [{
        type: "actions",
        elements: buttons
    }, {
        type: "divider"
    }, {
        type: "header",
        text: {
            type: "plain_text",
            text: "Players",
            emoji: true
        }
    }, {
        type: "rich_text",
        elements: [{
            type: "rich_text_list",
            style: "ordered",
            indent: 0,
            border: 0,
            elements
        }]
    }];
    if (game?.active && game.target === userId) {
        blocks.splice(1, 0, {
            type: "section",
            text: {
                type: "mrkdwn",
                text: "Tag another player"
            },
            accessory: {
                type: "users_select",
                placeholder: {
                    type: "plain_text",
                    text: "Select a user",
                    emoji: true
                },
                action_id: "tag_another_player",
            }
        });
    }

    await client.views.publish({
        user_id: userId,
        view: {
            type: "home",
            blocks
        }
    });
};
