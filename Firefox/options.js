// =====================================================================
// PlantUML for GitHub - Options page
// =====================================================================
// Manages the sites where the content script runs.
//
//   - Built-in sites (GitHub, GitHub Enterprise Cloud, local files) are
//     declared in the manifest. They can only be switched off: the
//     content script reads the `disabled` list from storage and stays
//     idle on those sites.
//   - Sites added by the user need a host permission (an optional
//     permission, asked for when the site is added) and a content script
//     registered at runtime with chrome.scripting.registerContentScripts.
//
// Storage (chrome.storage.sync, key "sites"):
//   { custom: ["*://gitlab.example.com/*", ...], disabled: ["ghe", ...] }
// =====================================================================

(function () {
  'use strict';

  const KEY = 'sites';
  const ID_PREFIX = 'site-';

  const BUILTIN = [
    { id: 'github', name: 'GitHub', pattern: 'https://github.com/*' },
    { id: 'ghe', name: 'GitHub Enterprise Cloud', pattern: 'https://*.ghe.com/*' },
    { id: 'file', name: 'Local files', pattern: 'file:///*' },
  ];

  const $ = (id) => document.getElementById(id);
  const builtinList = $('builtin');
  const customList = $('custom');
  const form = $('add');
  const input = $('site');
  const message = $('message');

  function say(text, kind) {
    message.textContent = text || '';
    message.className = kind || '';
  }

  // ------------------------------------------------------------------
  // Storage
  // ------------------------------------------------------------------
  async function load() {
    const res = await chrome.storage.sync.get(KEY);
    const sites = res[KEY] || {};
    return {
      custom: Array.isArray(sites.custom) ? sites.custom : [],
      disabled: Array.isArray(sites.disabled) ? sites.disabled : [],
    };
  }

  function save(sites) {
    return chrome.storage.sync.set({ [KEY]: sites });
  }

  // ------------------------------------------------------------------
  // Turn what the user typed into a match pattern.
  //
  //   gitlab.example.com        -> *://gitlab.example.com/*
  //   https://gitlab.example.com/group/project -> https://gitlab.example.com/*
  //   *.example.com             -> *://*.example.com/*
  //   http://localhost:3000     -> http://localhost:3000/*
  //
  // Throws an Error with a message fit to show to the user.
  // ------------------------------------------------------------------
  function normalize(raw) {
    let text = String(raw || '').trim();
    if (!text) throw new Error('Enter a site address, for example https://gitlab.example.com');

    let scheme = '*';
    const m = /^([a-z*]+):\/\//i.exec(text);
    if (m) {
      scheme = m[1].toLowerCase();
      text = text.slice(m[0].length);
    }
    if (scheme !== '*' && scheme !== 'http' && scheme !== 'https') {
      throw new Error('Only http and https sites can be added.');
    }

    const host = text.split(/[/?#]/)[0].toLowerCase();
    if (host === '*') return scheme + '://*/*';

    if (!/^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/.test(host)) {
      throw new Error('"' + host + '" is not a valid site address.');
    }
    // Chrome does not accept a port in a pattern that has no scheme.
    if (scheme === '*' && /:\d+$/.test(host)) {
      throw new Error('Start a site that has a port with http:// or https://, for example http://' + host);
    }
    const name = host.replace(/^\*\./, '').replace(/:\d+$/, '');
    if (name === 'github.com' || name.endsWith('.ghe.com') || name === 'ghe.com') {
      throw new Error('GitHub is already built in, see "Built-in sites" above.');
    }
    return scheme + '://' + host + '/*';
  }

  // ------------------------------------------------------------------
  // Content scripts for the sites added by the user
  // ------------------------------------------------------------------
  function idFor(pattern) {
    return ID_PREFIX + Array.from(pattern, (c) => c.charCodeAt(0).toString(16)).join('');
  }

  async function register(pattern) {
    const id = idFor(pattern);
    try { await chrome.scripting.unregisterContentScripts({ ids: [id] }); } catch (err) { /* not registered */ }
    await chrome.scripting.registerContentScripts([{
      id,
      matches: [pattern],
      js: ['content.js'],
      runAt: 'document_idle',
      persistAcrossSessions: true,
    }]);
  }

  async function unregister(pattern) {
    try { await chrome.scripting.unregisterContentScripts({ ids: [idFor(pattern)] }); } catch (err) { /* gone */ }
  }

  // Make the registered scripts match the list in storage (e.g. after the
  // extension was updated or the browser profile was synced).
  async function reconcile(sites) {
    const registered = await chrome.scripting.getRegisteredContentScripts();
    const have = new Set(registered.map((s) => s.id));
    const want = new Set(sites.custom.map(idFor));
    for (const pattern of sites.custom) {
      if (!have.has(idFor(pattern))) await register(pattern);
    }
    const stale = registered.filter((s) => s.id.startsWith(ID_PREFIX) && !want.has(s.id)).map((s) => s.id);
    if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale });
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------
  function el(tag, props, ...children) {
    const node = Object.assign(document.createElement(tag), props || {});
    for (const child of children) node.append(child);
    return node;
  }

  function nameCell(title, pattern, extra) {
    const small = el('small', {}, el('code', { textContent: pattern }));
    if (extra) small.append(' - ', extra);
    return el('div', { className: 'name' }, title, small);
  }

  async function render() {
    const sites = await load();

    builtinList.replaceChildren(...BUILTIN.map((site) => {
      const box = el('input', {
        type: 'checkbox',
        id: 'builtin-' + site.id,
        checked: !sites.disabled.includes(site.id),
      });
      box.addEventListener('change', async () => {
        const current = await load();
        current.disabled = current.disabled.filter((id) => id !== site.id);
        if (!box.checked) current.disabled.push(site.id);
        await save(current);
        say(site.name + (box.checked ? ' turned on.' : ' turned off.') + ' Reload open pages to apply.', 'ok');
      });
      return el('li', {}, box, el('label', { htmlFor: box.id, className: 'name' }, site.name,
        el('small', {}, el('code', { textContent: site.pattern }))));
    }));

    // Chrome needs a separate switch for file:// URLs.
    $('file-note').hidden = true;
    if (chrome.extension && chrome.extension.isAllowedFileSchemeAccess) {
      chrome.extension.isAllowedFileSchemeAccess((allowed) => { $('file-note').hidden = !!allowed; });
    }

    const rows = [];
    for (const pattern of sites.custom) {
      let granted = false;
      try { granted = await chrome.permissions.contains({ origins: [pattern] }); } catch (err) { /* ignore */ }

      const status = granted
        ? el('span', { className: 'status-ok', textContent: 'allowed' })
        : el('span', { className: 'status-missing', textContent: 'permission needed' });
      const buttons = [];
      if (!granted) {
        const grant = el('button', { type: 'button', textContent: 'Allow' });
        grant.addEventListener('click', async () => {
          // the request has to be the first thing in the click handler
          const ok = await chrome.permissions.request({ origins: [pattern] });
          say(ok ? 'Permission granted.' : 'Permission was not granted.', ok ? 'ok' : 'error');
          render();
        });
        buttons.push(grant);
      }
      const remove = el('button', { type: 'button', className: 'danger', textContent: 'Remove' });
      remove.addEventListener('click', async () => {
        const current = await load();
        current.custom = current.custom.filter((p) => p !== pattern);
        await save(current);
        await unregister(pattern);
        try { await chrome.permissions.remove({ origins: [pattern] }); } catch (err) { /* ignore */ }
        say('Removed ' + pattern, 'ok');
        render();
      });
      buttons.push(remove);
      rows.push(el('li', {}, nameCell(pattern.replace(/\/\*$/, ''), pattern, status), ...buttons));
    }
    customList.replaceChildren(...(rows.length
      ? rows
      : [el('li', { className: 'empty', textContent: 'No sites added yet.' })]));
    $('wildcard-note').hidden = !sites.custom.some((p) => /^[^:]+:\/\/\*\//.test(p));
  }

  // ------------------------------------------------------------------
  // Add a site
  // ------------------------------------------------------------------
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    say('');
    let pattern;
    try {
      pattern = normalize(input.value);
    } catch (err) {
      say(err.message, 'error');
      return;
    }
    // chrome.permissions.request must be called from the user gesture,
    // before any other await.
    chrome.permissions.request({ origins: [pattern] }).then(async (granted) => {
      if (!granted) {
        say('Permission was not granted, the site was not added.', 'error');
        return;
      }
      const sites = await load();
      if (sites.custom.includes(pattern)) {
        say(pattern + ' is already in the list.', 'error');
        return;
      }
      try {
        await register(pattern);
      } catch (err) {
        // do not keep a permission for a site that was not added
        try { await chrome.permissions.remove({ origins: [pattern] }); } catch (e) { /* ignore */ }
        throw err;
      }
      sites.custom.push(pattern);
      await save(sites);
      input.value = '';
      say('Added ' + pattern + '. Reload the open pages of the site to apply.', 'ok');
      render();
    }).catch((err) => say(err.message || String(err), 'error'));
  });

  load().then(async (sites) => {
    try { await reconcile(sites); } catch (err) { say(err.message || String(err), 'error'); }
    render();
  });
})();
