import { EventEmitter } from 'events';

interface ChatMessage {
    username: string;
    displayName: string;
    timestamp: number;
    text: string;
    avatar: string;
    eventTypeId: number;  // 24 for X, 4 for Twitch
}

type LLMCallback = (message: string) => Promise<{
    processed: boolean;
    error?: string;
}>;

// TODO: Add middle out. Even though OpenRouter uses middle out, we should do it on our side
// to prevent the requests to OpenRouter from being too large.

export class WebSocketService extends EventEmitter {
    private ws: WebSocket | null = null;
    private currentToken: string | null = null;
    private llmCallback: LLMCallback | null = null;
    private reconnectionPromise: Promise<void> | null = null;
    private isReconnecting: boolean = false;
    
    // New state management properties
    private messageQueue: ChatMessage[] = [];
    private isProcessing: boolean = false;
    private batchTimeout: NodeJS.Timeout | null = null;
    private readonly BATCH_DELAY = 1000; // Wait 1 second to batch messages
    
    constructor() {
        super();
    }

    // Updated to handle async callback
    setLLMCallback(callback: LLMCallback) {
        this.llmCallback = callback;
    }

    private handleWebSocketMessage = (event: MessageEvent) => {
        try {
            const data = JSON.parse(event.data);
            this.emit('rawMessage', data);
            
            if (data.action === 'event' && 
                (data.payload.eventTypeId === 24 || data.payload.eventTypeId === 4)) {
                this.handleChatMessage(data);
            }
        } catch (err) {
            console.error('Error parsing message:', err);
        }
    };

    private handleWebSocketClose = () => {
        // Only emit connection change if we're not in the middle of reconnecting
        if (!this.isReconnecting) {
            this.emit('connectionChange', false);
        }
    };

    private handleWebSocketError = (error: Event) => {
        console.error('WebSocket error:', error);
        this.emit('connectionChange', false);
    };

    private handleWebSocketOpen = () => {
        console.log('WebSocket connection established');
        this.emit('connectionChange', true);
    };

    private setupEventHandlers() {
        if (!this.ws) return;

        this.ws.onmessage = this.handleWebSocketMessage;
        this.ws.onclose = this.handleWebSocketClose;
        this.ws.onerror = this.handleWebSocketError;
        this.ws.onopen = this.handleWebSocketOpen;
    }

    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        // Clear the interval when disconnecting
        if (this.batchTimeout) {
            clearInterval(this.batchTimeout);
            this.batchTimeout = null;
        }
    }

    isConnected() {
        return this.ws?.readyState === WebSocket.OPEN;
    }

    public handleChatMessage(data: any) {
        const payload = data.payload;
        const messageData = payload.eventPayload;
        
        const chatMessage: ChatMessage = {
            username: messageData.author.username,
            displayName: messageData.author.displayName,
            timestamp: data.timestamp,
            text: messageData.text,
            avatar: messageData.author.avatar,
            eventTypeId: payload.eventTypeId
        };
        
        this.emit('chatMessage', chatMessage);
        this.queueMessage(chatMessage);
    }

    private queueMessage(message: ChatMessage) {
        this.messageQueue.push(message);
        
        // Only start the interval if it's not already running
        if (!this.batchTimeout) {
            this.batchTimeout = setInterval(() => {
                this.processMessageQueue();
            }, this.BATCH_DELAY);
        }
    }

    private async processMessageQueue() {
        // If already processing or no messages, return
        if (this.isProcessing || this.messageQueue.length === 0 || !this.llmCallback) {
            return;
        }

        this.isProcessing = true;
        
        // Take a snapshot of current messages to process, leaving the queue open for new messages
        const messagesToProcess = [...this.messageQueue];
        // Clear only the messages we're about to process
        this.messageQueue = this.messageQueue.slice(messagesToProcess.length);

        try {
            const formattedMessages = messagesToProcess
                .map(msg => `${msg.displayName}: ${msg.text}`)
                .join('\n');

            console.log(`Processing ${messagesToProcess.length} messages in batch`);
            
            const prompt = `Received these messages from your livestream, please respond:\n${formattedMessages}`;
            
            const result = await this.llmCallback(prompt);
            if (!result.processed) {
                console.log(`Message processing skipped: ${result.error}`);
                // Add failed messages back to the front of the queue
                this.messageQueue = [...messagesToProcess, ...this.messageQueue];
            }
        } catch (error) {
            console.error('Error processing message queue:', error);
            // Add failed messages back to the front of the queue
            this.messageQueue = [...messagesToProcess, ...this.messageQueue];
        } finally {
            this.isProcessing = false;
        }
    }

}

export const websocketService = new WebSocketService(); 