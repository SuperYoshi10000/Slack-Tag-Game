import { App, KnownEventFromType } from "@slack/bolt";
import { MessageEvent, GenericMessageEvent, ActionsBlockElement, Block, KnownBlock } from "@slack/types";
import "dotenv/config";
import * as fs from "fs";
import { writeFile } from "fs";

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

(async () => {
    // Start your app
    await app.start(process.env.PORT || 3000);
    console.log("⚡️ Bolt app is running!");
})();

let game: TagGame;
class TagGame {
    players: Set<string> = new Set();
    scores: Map<string, number> = new Map();
    host: string | null = null;
    active: boolean = false;
    channel?: string;
    target: string | null = null;
    lastActionTimestamp: number = Date.now(); // Initialize with the current timestamp

    constructor(channel?: string) {
        this.channel = channel;
    }
    start(startingPlayer: string) {
        this.host = startingPlayer;
        this.players.add(startingPlayer);
        this.active = true;
    }
    join(player: string) {
        this.players.add(player);
        if (!this.scores.has(player)) {
            this.scores.set(player, 0);
        }
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
        this.scores.clear();
        this.host = null;
        this.active = false;
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
        // Load game data from a database or file
        if (fs.existsSync("gameData.json")) {
            fs.readFile("gameData.json", "utf8", (err, data) => {
                if (err) {
                    console.error("Error loading game data:", err);
                    return;
                }
                const gameData = JSON.parse(data);
                // Restore game state
                game = new TagGame();
                game.players = new Set(gameData.players);
                game.scores = new Map(gameData.scores);
                game.target = gameData.target;
                game.lastActionTimestamp = gameData.lastActionTimestamp;
            });
        }
    }
};

app.command("/tag-game", async ({ command, ack, say, client }) => {
    let action = command.text.split(" ")[0].trim().toLowerCase();
    await ack();
    const userId = command.user_id;

    switch (action) {
        case "start":
            console.log(`Player "${userId}" is starting a game`);
            if (game?.active) {
                await say("A game is already in progress.");
                return;
            }
            let gameId = command.text.split(" ")[1]?.trim();
            switch (gameId) {
                case "tag":
                    TagGame.load();
                    game.start(userId);
                    break;
                case "":
                    await say("Please specify a game type. Available types: `tag`.");
                    return;
                default:
                    await say("Unknown game type. Please specify a valid game type.");
                    return;
            }
            break;
        case "join":
            console.log(`Player "${userId}" is joining the game`);
            if (!game) {
                await say("No game is currently in progress. Please start a game first.");
                return;
            }
            if (!game.players.has(userId)) {
                game.join(userId);
            } else {
                await say("You are already in the game.");
            }
            break;
        case "leave":
            console.log(`Player "${userId}" is leaving the game`);
            if (!game) {
                await say("No game is currently in progress.");
                return;
            }
            if (!game.players.has(userId)) {
                await say("You are not in the game.");
                return;
            }
            if (!game.leave(userId)) {
                await say("Failed to leave the game. You might be the target.");
                return;
            }
            await say("You have left the game.");
            break;
        case "stop":
            console.log(`Player "${userId}" is stopping the game`);
            if (!game) {
                await say("No game is currently in progress.");
                return;
            }
            if (userId !== game.host) {
                await say("Only the game host can stop the game.");
                return;
            }
            game.stop();
            await say("The game has been stopped.");
            game.save();
            break;
        default:
            const tagTarget = command.text.trim().replace(/^<@|[|>].*$/g, ""); // Remove <@ and |NAME> to get the user ID

            console.log(`Player "${userId}" is tagging "${tagTarget}"`);
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
            game.lastActionTimestamp = currentTime; // Update the last action timestamp
            game.scores.set(userId, Math.max((game.scores.get(userId) || 0) + Math.floor(timeSinceLastAction * TIME_MULTIPLIER_TAGGER), 0));
            game.scores.set(tagTarget, Math.max((game.scores.get(tagTarget) || 0) + Math.floor(timeSinceLastAction * TIME_MULTIPLIER_TAGGED), 0));
            game.save();
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
    
app.event("app_home_opened", async ({ event, client }) => {
    const userId = event.user;

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

    client.views.publish({
        user_id: userId,
        view: {
            type: "home",
            blocks
        }
    });
});

app.action("start_game_action", async ({ body, ack, respond, client, context }) => {
    await ack();
    const userId = body.user.id;
    console.log(`Player "${userId}" is starting a game`);
    // Start the game logic here
    if (game?.active) {
        await respond("A game is already in progress.");
        return;
    }
    TagGame.load();
    game?.start(userId);
});

app.action("join_game_action", async ({ body, ack, respond }) => {
    await ack();
    console.log(`Player "${body.user.id}" is joining the game`);
    const userId = body.user.id;
    if (!game) {
        await respond("No game is currently in progress. Please start a game first.");
        return;
    }
    if (!game.players.has(userId)) {
        game.join(userId);
    } else {
        await respond("You are already in the game.");
    }
});
app.action("stop_game_action", async ({ body, ack, respond }) => {
    await ack();
    const userId = body.user.id;
    console.log(`Player "${userId}" is stopping the game`);
    if (!game) {
        await respond("No game is currently in progress.");
        return;
    }
    if (userId !== game.host) {
        await respond("Only the game host can stop the game.");
        return;
    }
    game.stop();
    await respond("The game has been stopped.");
    game.save();
});
app.action("leave_game_action", async ({ body, ack, respond }) => {
    await ack();
    const userId = body.user.id;

    console.log(`Player "${userId}" leaving the game`);
    
    if (!game) {
        await respond("No game is currently in progress.");
        return;
    }
    if (!game.players.has(userId)) {
        await respond("You are not in the game.");
        return;
    }
    if (!game.leave(userId)) {
        await respond("Failed to leave the game. You might be the target.");
        return;
    }
    await respond("You have left the game.");
});
app.action("tag_another_player", async ({ body, ack, respond }) => {
    await ack();
    const userId = body.user.id;
    const tagTarget = body.type === "block_actions" && body.actions[0].type === "users_select" ? body.actions[0].selected_user : null;
    
    console.log(`Player "${userId}" is tagging "${tagTarget}"`);

    if (!game) {
        await respond("No game is currently in progress. Please start a game first.");
        return;
    }

    // Handle game actions specific to the tag game
    if (!tagTarget) {
        await respond("Please specify a player to tag.");
        return;
    }
    if (!game.players.has(userId)) {
        await respond("You are not a player in this game. Please join the game first.");
        return;
    }
    if (!(userId === game.target) ) {
        await respond("You can only tag while you are it.");
        return;
    }
    if (!game.players.has(tagTarget)) {
        await respond("You can only tag players in the game.");
        return;
    }
    if (userId === tagTarget) {
        await respond("You cannot tag yourself.");
        return;
    }
    // Tag the target player
    game.target = tagTarget;
    let lastActionTimestamp = game.lastActionTimestamp;
    let currentTime = Date.now();
    let timeSinceLastAction = Math.floor((currentTime - lastActionTimestamp) / 5);
    if (timeSinceLastAction < 5) { // 5 seconds cooldown
        await respond(`You must wait at least 5 seconds before tagging again. Time since last action: ${timeSinceLastAction} seconds.`);
        return;
    }
    game.lastActionTimestamp = currentTime; // Update the last action timestamp
    game.scores.set(userId, Math.max((game.scores.get(userId) || 0) + Math.floor(timeSinceLastAction * TIME_MULTIPLIER_TAGGER), 0));
    game.scores.set(tagTarget, Math.max((game.scores.get(tagTarget) || 0) + Math.floor(timeSinceLastAction * TIME_MULTIPLIER_TAGGED), 0));
    game.save();
});