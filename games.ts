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
    scores: Map<string, number> = new Map();
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
        this.players.add(startingPlayer);
        if (!this.scores.has(startingPlayer)) {
            this.scores.set(startingPlayer, 0);
        }
        this.active = true;
        this.target = startingPlayer; // The starting player is the initial target
        this.lastActionTimestamp = Date.now();
        this.save();
    }
    join(player: string) {
        this.players.add(player);
        if (!this.scores.has(player)) {
            this.scores.set(player, 0);
        }
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
        this.save()
    }
    save() {
        const gameData = {
            players: Array.from(this.players),
            scores: Array.from(this.scores.entries()),
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
        });
    }
    static load() {
        game = new TagGame();
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
        }
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
                    blocks: getInviteMenuContent()
                });
            } else if (selectedUsers.length > MAX_USER_INVITE_COUNT) await say(`You can only invite up to ${MAX_USER_INVITE_COUNT} users at a time.`);
            else await invitePeopleToPlay(userId, selectedUsers, client, say);
            break;
        default:
            const tagTarget = command.text.trim().replace(/^<@|[|>].*$/g, "");
            await tagAnotherPlayer(userId, tagTarget, client, say);
            break;
    }


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

function getInviteMenuContent() {
    return [{
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
    if (!game.players.has(tagTarget)) {
        await reply("You can only tag players in the game.", userId, client);
        return;
    }
    if (userId === tagTarget) {
        await reply("You cannot tag yourself.", userId, client);
        return;
    }
    // Tag the target player
    game.target = tagTarget;
    let lastActionTimestamp = game.lastActionTimestamp;
    let currentTime = Date.now();
    let timeSinceLastAction = Math.floor((currentTime - lastActionTimestamp) / 5);
    if (timeSinceLastAction < 5) { // 5 seconds cooldown
        await reply(`You must wait at least 5 seconds before tagging again. Time since last action: ${timeSinceLastAction} seconds.`, userId, client);
        return;
    }
    game.lastActionTimestamp = currentTime; // Update the last action timestamp
    game.scores.set(userId, Math.max((game.scores.get(userId) || 0) + Math.floor(timeSinceLastAction * TIME_MULTIPLIER_TAGGER), 0));
    game.scores.set(tagTarget, Math.max((game.scores.get(tagTarget) || 0) + Math.floor(timeSinceLastAction * TIME_MULTIPLIER_TAGGED), 0));
    game.save();
    await showHomeView(userId, client);
}

async function invitePeopleToPlay(userId: string, selectedUsers: string[], client: WebClient, reply: SendMessageFunction) {
    console.log(`Player "${userId}" is inviting ${selectedUsers.length} user(s) to play tag`);
    for (const invitedUser of selectedUsers) {
        reply(`You have been invited to play tag by <@${userId}>!`, invitedUser, client); // No await here, we want to send all invites in parallel
    }
    await reply(`You have invited ${selectedUsers.length} user(s) to play tag.`, userId, client);
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

app.action("invite_people_action", async ({ body, ack, client, action, payload }) => {
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

app.action("invite_people_to_play", async ({ body, ack, client }) => {
    await ack();
    const userId = body.user.id;
    const selectedUsers = body.type === "block_actions" && body.actions[0].type === "multi_users_select" ? body.actions[0].selected_users : [];
    await invitePeopleToPlay(userId, selectedUsers, client, sendMessage);
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
setInterval(() => {
    givePoints();
}, SCORE_INTERVAL);

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
    const elements = Array.from(game?.scores.entries() || []).sort((a, b) => b[1] - a[1]).map(([player, score]) => ({
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
    const buttonText = game?.active ? (isPlaying ? "Leave Game" : "Join Game") : "Start Game";
    const buttonValue = game?.active ? (isPlaying ? "leave_game" : "join_game") : "start_game";
    const buttonAction = game?.active ? (isPlaying ? "leave_game_action" : "join_game_action") : "start_game_action";

    const buttons: ActionsBlockElement[] = [{
        type: "button",
        text: {
            type: "plain_text",
            text: buttonText,
            emoji: true,
        },
        value: buttonValue,
        action_id: buttonAction,
        style: "primary",
    }];
    if (game?.active && game.host === userId) {
        buttons.push({
            type: "button",
            text: {
                type: "plain_text",
                text: "Stop Game",
                emoji: true
            },
            value: "stop_game",
            action_id: "stop_game_action",
            style: "danger"
        }, {
            type: "button",
            text: {
                type: "plain_text",
                text: "Invite People",
                emoji: true
            },
            value: "invite_people",
            action_id: "invite_people_action",
        });
    }

    const blocks: KnownBlock[] = [{
        type: "actions",
        elements: buttons
    }, {
        type: "divider"
    }, {
        type: "header",
        text: {
            type: "plain_text",
            text: "Leaderboard",
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

function givePoints() {
    if (!game || !game.active) return; // No active game
    const currentTime = Date.now();
    for (const player of game.players) {
        const score = game.scores.get(player) || 0;
        const newScore = Math.max(score + (player === game.target ? SCORE_TARGET : SCORE_NON_TARGET), 0);
        game.scores.set(player, newScore);
        console.log(`Player ${player} score updated: ${newScore}`);
    }
    game.lastActionTimestamp = currentTime; // Update the last action timestamp
    game.save();
}