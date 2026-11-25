const HAVE_CURRENT_DATA = 2;

function mediaError(video: HTMLMediaElement, fallback: string): Error {
  return new Error(video.error?.message || fallback);
}

/** Waits until decoded data for the video's current playback position is available. */
export function waitForVideoFrame(video: HTMLVideoElement, timeoutMs = 15_000): Promise<void> {
  if (video.readyState >= HAVE_CURRENT_DATA) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      video.removeEventListener('loadeddata', onFrameData);
      video.removeEventListener('canplay', onFrameData);
      video.removeEventListener('seeked', onFrameData);
      video.removeEventListener('error', onError);
    };
    const finish = () => {
      cleanup();
      resolve();
    };
    const onFrameData = () => {
      if (video.readyState >= HAVE_CURRENT_DATA) finish();
    };
    const onError = () => {
      cleanup();
      reject(mediaError(video, 'Video frame could not be decoded.'));
    };

    video.addEventListener('loadeddata', onFrameData);
    video.addEventListener('canplay', onFrameData);
    video.addEventListener('seeked', onFrameData);
    video.addEventListener('error', onError);
    timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Decoded video frame was not available before the timeout.'));
    }, timeoutMs);
    onFrameData();
  });
}

/** Seeks when needed and always waits for decoded data at the requested time. */
export async function seekVideoTo(video: HTMLVideoElement, seconds: number, timeoutMs = 10_000): Promise<void> {
  if (Math.abs(video.currentTime - seconds) >= 0.001) {
    await new Promise<void>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timeout !== undefined) clearTimeout(timeout);
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('error', onError);
      };
      const onSeeked = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(mediaError(video, 'Video seek failed.'));
      };

      video.addEventListener('seeked', onSeeked);
      video.addEventListener('error', onError);
      timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Video seek timed out at ${seconds.toFixed(3)} s.`));
      }, timeoutMs);
      try {
        video.currentTime = seconds;
      } catch (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  await waitForVideoFrame(video, timeoutMs);
}
