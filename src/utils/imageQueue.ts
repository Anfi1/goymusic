/**
 * Global utility to rate-limit image requests to avoid 429 errors.
 * Uses a stack-based approach (LIFO) so that images visible on screen 
 * (the ones requested last during fast scroll) are prioritized.
 */

type ImageRequest = {
    id: string;
    src: string;
    onReady: () => void;
};

class ImageQueue {
    private queue: ImageRequest[] = [];
    private activeCount = 0;
    private maxConcurrency = 6; // Reduced from 15 to be more conservative
    private cache = new Set<string>(); // Tracks successfully loaded images in this session
    private lastRequestTime = 0;
    private minDelay = 20; // 20ms minimum delay between starting requests

    /**
     * Enqueue an image load request.
     * @returns A function to cancel the request.
     */
    enqueue(src: string, onReady: () => void): () => void {
        // Fast path: if we already loaded this in the session or it's potentially cached
        if (this.cache.has(src)) {
            onReady();
            return () => {};
        }

        const id = Math.random().toString(36).substring(7);

        // Add to the START of the queue (LIFO priority)
        this.queue.unshift({ id, src, onReady });
        
        this.process();

        return () => {
            // Cancellation logic: remove from queue if not started
            this.queue = this.queue.filter(req => req.id !== id);
        };
    }

    private process() {
        if (this.activeCount >= this.maxConcurrency || this.queue.length === 0) {
            return;
        }

        const now = Date.now();
        const timeSinceLast = now - this.lastRequestTime;
        
        if (timeSinceLast < this.minDelay) {
            setTimeout(() => this.process(), this.minDelay - timeSinceLast);
            return;
        }

        const request = this.queue.shift();
        if (!request) return;

        this.activeCount++;
        this.lastRequestTime = Date.now();

        // We use a small image object just to "pre-warm" or check cache
        const img = new Image();
        
        const done = (isSuccess: boolean) => {
            if (isSuccess) this.cache.add(request.src);
            this.activeCount--;
            
            // AGGRESSIVE MEMORY CLEANUP
            img.onload = null;
            img.onerror = null;
            img.src = '';
            
            request.onReady();
            
            // Small async break to let the UI thread breathe
            setTimeout(() => this.process(), 0);
        };

        // If browser says it's already complete (cached), don't even wait
        img.src = request.src;
        if (img.complete) {
            done(true);
            return;
        }

        img.onload = () => done(true);
        img.onerror = () => done(false);
    }
}

export const imageQueue = new ImageQueue();
