import { App, KnownEventFromType } from "@slack/bolt";
import { MessageEvent, GenericMessageEvent } from "@slack/types";
import "dotenv/config";

const SCORE_NON_TARGET = 1; // Points for not being the target
const SCORE_TARGET = -5; // Points for being the target
const TIME_MULTIPLIER_TAGGED = -0.1; // Multiplier for time-based scoring
const TIME_MULTIPLIER_TAGGER = 0.1; // Multiplier for time-based scoring in general

const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    clientId: process.env.SLACK_CLIENT_ID,
    clientSecret: process.env.SLACK_CLIENT_SECRET,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
});

let game: Game | null = null;
interface Game {    
    readonly players: Set<string>;
    readonly scores: Map<string, number>;
    host: string | null;
    active: boolean;
    channel: string;
    target: string | null;
    lastActionTimestamp: number; // Optional timestamp to track the last action time

    start(startingPlayer: string): void;
    join(player: string): void;
    leave(player: string): void;
    stop(): void;
}
class TagGame implements Game {
    readonly players: Set<string> = new Set();
    readonly scores: Map<string, number> = new Map();
    host: string | null = null;
    active: boolean = false;
    channel: string;
    target: string | null = null;
    lastActionTimestamp: number = Date.now(); // Initialize with the current timestamp

    constructor(channel: string) {
        this.players = new Set();
        this.active = false;
        this.channel = channel;
    }
    start(startingPlayer: string) {
        this.host = startingPlayer;
        this.players.add(startingPlayer);
        this.active = true;
    }
    join(player: string) {
        this.players.add(player);
        this.scores.set(player, 0);
    }
    leave(player: string) {
        if (this.players.has(player)) {
            this.players.delete(player);
            this.scores.delete(player);
            if (this.players.size === 0) {
                this.stop();
                return;
            }
            if (this.target === player) {
                this.target = Array.from(this.players)[Math.floor(Math.random() * this.players.size)] || null;
            }
            if (this.host === player) {
                this.host = Array.from(this.players)[0] || null; // Assign a new host if the current host leaves
            }
        }
    }
    stop() {
        this.players.clear();
        this.scores.clear();
        this.host = null;
        this.active = false;
        this.target = null;
    }
}

app.command("/playgame", async ({ command, ack, say, client }) => {
    let action = command.text.split(" ")[0].trim().toLowerCase();
    await ack();
    const userId = command.user_id;

    switch (action) {
        case "start":
            if (game) {
                await say("A game is already in progress.");
                return;
            }
            let gameId = command.text.split(" ")[1]?.trim();
            switch (gameId) {
                case "tag":
                    game = new TagGame(command.channel_id);
                    game.start(userId);
                    break;
                case "":
                    await say("Please specify a game type. Available types: `tag`.");
                    return;
                default:
                    await say("Unknown game type. Please specify a valid game type.");
                    return;
            }

            await client.chat.postMessage({
                text: `Game started by <@${userId}>!`,
                channel: command.channel_id,
            });
            break;
        case "join":
            if (!game) {
                await say("No game is currently in progress. Please start a game first.");
                return;
            }
            if (!game.players.has(userId)) {
                game.join(userId);
                await client.chat.postMessage({
                    text: `<@${userId}> has joined the game!`,
                    channel: command.channel_id,
                });
            } else {
                await say("You are already in the game.");
            }
            break;
        case "leave":
            if (!game) {
                await say("No game is currently in progress.");
                return;
            }
            if (!game.players.has(userId)) {
                await say("You are not in the game.");
                return;
            }
            let oldHost = game.host;
            game.players.delete(userId);
            if (game.players.size > 0) {
                await client.chat.postMessage({
                    text: `<@${userId}> has left the game.` + (oldHost === userId ? ` The new host is <@${game.host}>.` : ""),
                    channel: command.channel_id,
                });
                break;
            }
            // If no players left, continue to stop the game
        case "stop":
            if (!game) {
                await say("No game is currently in progress.");
                return;
            }
            if (userId !== game.host) {
                await say("Only the game host can stop the game.");
                return;
            }
            game.stop();
            await client.chat.postMessage({
                text: `Game stopped by <@${userId}>.`,
                channel: command.channel_id,
            });
            game = null;
            break;
        default:
            await say("Unknown action. Please use `start` or `join`.");
            break;
    }
});

app.command("/game-tag", async ({ command, ack, say }) => {
    await ack();
    const userId = command.user_id;
    const tagTarget = command.text.trim().replace(/<@|>/g, ""); // Remove <@ and > to get the user ID
    if (!game) {
        await say("No game is currently in progress. Please start a game first.");
        return;
    }

    // Handle game actions specific to the tag game
    if (!tagTarget) {
        await say("Please specify a player to tag. Usage: `/game-tag @name`");
        return;
    }
    if (!game.players.has(userId)) {
        await say("You are not a player in this game. Please join the game first.");
        return;
    }
    if (!(command.user_id === game.target) ) {
        await say("You can only tag while you are it.");
        return;
    }
    if (!game.players.has(tagTarget)) {
        await say("You can only tag players in the game.");
        return;
    }
    if (command.user_id === tagTarget) {
        await say("You cannot tag yourself.");
        return;
    }
    // Tag the target player
    game.target = tagTarget;
    let lastActionTimestamp = game.lastActionTimestamp;
    let currentTime = Date.now();
    let timeSinceLastAction = Math.floor((currentTime - lastActionTimestamp) / 5);
    if (timeSinceLastAction < 5) { // 5 seconds cooldown
        await say(`You must wait at least 5 seconds before tagging again. Time since last action: ${timeSinceLastAction} seconds.`);
        return;
    }
    game.scores.set(userId, Math.max((game.scores.get(userId) || 0) + Math.floor(timeSinceLastAction * TIME_MULTIPLIER_TAGGER), 0));
    game.scores.set(tagTarget, Math.max((game.scores.get(tagTarget) || 0) + Math.floor(timeSinceLastAction * TIME_MULTIPLIER_TAGGED), 0));
});

// Score points whenever a message is sent in any channel
// This is a simple scoring system where each player gets 1 point for not being the target and -5 points for being the target
app.event("message.channels", async ({ event }) => {
    const messageEvent = event as unknown as MessageEvent;
    if (messageEvent.subtype) return; // Only process regular messages, not subtypes
    if (game) for (const player of game.players) {
        game.scores.set(player, Math.max((game.scores.get(player) || 0) + (player === game.target ? SCORE_TARGET : SCORE_NON_TARGET), 0));
    }
});
    