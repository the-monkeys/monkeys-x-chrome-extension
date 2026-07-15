import './content.css';

// Helper to extract Tweet ID from article link elements
function getTweetIdFromArticle(article: HTMLElement): string | null {
  const links = article.querySelectorAll('a[href*="/status/"]');
  for (const link of links) {
    const href = link.getAttribute('href');
    if (href) {
      // Matches /username/status/1234567890
      const match = href.match(/\/status\/(\d+)/);
      if (match) {
        return match[1];
      }
    }
  }
  return null;
}

// Helper to reset button to normal state
function resetBtn(btn: HTMLButtonElement) {
  btn.className = 'monkeys-action-btn';
  btn.disabled = false;
  btn.innerHTML = `
    <svg viewBox="0 0 24 24">
      <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
    </svg>
    <span>Monkeys</span>
  `;
}

// Injects toast notifications into the page body
function showToast(title: string, message: string, type: 'info' | 'success' | 'error' = 'info') {
  let container = document.querySelector('.monkeys-toast-container') as HTMLElement;
  if (!container) {
    container = document.createElement('div');
    container.className = 'monkeys-toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `monkeys-toast ${type}`;

  const iconSvg = type === 'success' 
    ? '<svg viewBox="0 0 24 24" fill="#10b981"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>'
    : type === 'error'
      ? '<svg viewBox="0 0 24 24" fill="#ef4444"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="#7c3aed"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>';

  toast.innerHTML = `
    <div class="monkeys-toast-header">
      ${iconSvg}
      <span>${title}</span>
    </div>
    <div class="monkeys-toast-body">
      ${message}
    </div>
  `;

  container.appendChild(toast);

  // Trigger browser paint to start slide-in transition
  setTimeout(() => {
    toast.classList.add('show');
  }, 10);

  // Remove toast after duration
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => {
      toast.remove();
    }, 500);
  }, 4500);
}

// Injects the Monkeys automation action button into X feed tweets
function injectButtons() {
  const articles = document.querySelectorAll('article');
  
  articles.forEach((article) => {
    // Locate the toolbar action bar
    const toolbar = article.querySelector('div[role="group"]');
    if (toolbar && !toolbar.hasAttribute('data-monkeys-injected')) {
      toolbar.setAttribute('data-monkeys-injected', 'true');
      
      const tweetId = getTweetIdFromArticle(article as HTMLElement);
      if (!tweetId) return;

      const container = document.createElement('div');
      container.style.display = 'flex';
      container.style.alignItems = 'center';

      const btn = document.createElement('button');
      btn.className = 'monkeys-action-btn';
      btn.innerHTML = `
        <svg viewBox="0 0 24 24">
          <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
        </svg>
        <span>Monkeys</span>
      `;

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();

        btn.disabled = true;
        btn.querySelector('span')!.textContent = 'Queuing...';

        chrome.runtime.sendMessage(
          {
            type: 'CREATE_AUTOMATION_JOB',
            payload: { tweetId, replyToTweetId: tweetId }
          },
          (response) => {
            if (chrome.runtime.lastError) {
              btn.className = 'monkeys-action-btn error';
              btn.querySelector('span')!.textContent = 'Error';
              showToast('Error', 'Extension background service worker not responding.', 'error');
              setTimeout(() => resetBtn(btn), 3000);
              return;
            }

            if (response && response.success) {
              btn.className = 'monkeys-action-btn success';
              btn.querySelector('span')!.textContent = 'Queued!';
              showToast('Job Enqueued', `Tweet snapshot job successfully created with status: ${response.job.status}`, 'success');
              setTimeout(() => resetBtn(btn), 3000);
            } else {
              btn.className = 'monkeys-action-btn error';
              btn.querySelector('span')!.textContent = 'Error';
              showToast('Failed to queue', response?.error || 'Unknown error occurred.', 'error');
              setTimeout(() => resetBtn(btn), 3000);
            }
          }
        );
      });

      // Append to the toolbar
      toolbar.appendChild(container);
      container.appendChild(btn);
    }
  });
}

// Observe the DOM to inject buttons dynamically as the feed loads
const observer = new MutationObserver(() => {
  injectButtons();
});

// Run initial injection
injectButtons();

// Start observing body mutations
observer.observe(document.body, {
  childList: true,
  subtree: true
});
