// Served at /setup/app.js
// No fancy syntax: keep it maximally compatible.

(function () {
  // Header status elements
  var statusDot = document.getElementById('status-dot');
  var statusText = document.getElementById('status-text');

  // Auth config elements
  var authGroupEl = document.getElementById('authGroup');

  // Setup log elements
  var logEl = document.getElementById('log');
  var setupErrorEl = document.getElementById('setup-error');

  // Debug console
  var consoleCmdEl = document.getElementById('consoleCmd');
  var consoleArgEl = document.getElementById('consoleArg');
  var consoleRunEl = document.getElementById('consoleRun');
  var consoleOutEl = document.getElementById('consoleOut');

  // Config editor
  var configPathEl = document.getElementById('configPath');
  var configTextEl = document.getElementById('configText');
  var configReloadEl = document.getElementById('configReload');
  var configSaveEl = document.getElementById('configSave');
  var configOutEl = document.getElementById('configOut');

  // Import
  var importFileEl = document.getElementById('importFile');
  var importRunEl = document.getElementById('importRun');
  var importOutEl = document.getElementById('importOut');

  // Buttons
  var startSetupBtn = document.getElementById('startSetup');
  var completeSetupBtn = document.getElementById('completeSetup');

  // API key input
  var authSecretEl = document.getElementById('authSecret');
  var authSecretHintEl = document.getElementById('authSecretHint');

  // Auth groups from status (includes envVarSet per provider)
  var authGroupsData = [];

  // State tracking
  var convosJoined = false;
  var statusCheckInProgress = true;

  function setStatus(text, state) {
    if (statusText) statusText.textContent = text;
    if (statusDot) {
      statusDot.className = 'status-dot';
      if (state === 'success') {
        statusDot.style.background = '#34C759';
      } else if (state === 'pending') {
        statusDot.classList.add('pending');
      } else if (state === 'error') {
        statusDot.classList.add('error');
      }
    }
  }

  function showError(message) {
    if (setupErrorEl) {
      setupErrorEl.textContent = message;
      setupErrorEl.style.display = 'block';
    }
  }

  function hideError() {
    if (setupErrorEl) {
      setupErrorEl.style.display = 'none';
    }
  }

  function showLog(content) {
    if (logEl) {
      logEl.textContent = content;
      logEl.style.display = 'block';
    }
  }

  function appendLog(content) {
    if (logEl) {
      logEl.textContent += content;
      logEl.style.display = 'block';
    }
  }

  function renderAuth(groups) {
    if (!authGroupEl) return;
    authGroupEl.innerHTML = '';
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      var opt = document.createElement('option');
      opt.value = g.value;
      opt.textContent = g.label + (g.hint ? ' - ' + g.hint : '');
      authGroupEl.appendChild(opt);
    }
  }

  function httpJson(url, opts) {
    opts = opts || {};
    opts.credentials = 'same-origin';
    return fetch(url, opts).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          throw new Error('HTTP ' + res.status + ': ' + (t || res.statusText));
        });
      }
      return res.json();
    });
  }

  function setStartSetupLoading(loading) {
    if (!startSetupBtn) return;
    if (loading) {
      startSetupBtn.disabled = true;
      startSetupBtn.classList.add('loading');
      var btnTpl = document.getElementById('snippet-btn-loading');
      startSetupBtn.innerHTML = btnTpl ? btnTpl.innerHTML : 'Loading...';
    } else {
      startSetupBtn.classList.remove('loading');
      startSetupBtn.textContent = 'Start Setup';
      updateStartSetupEnabled();
    }
  }

  function updateStartSetupEnabled() {
    if (!startSetupBtn || statusCheckInProgress) return;
    var idx = authGroupEl ? parseInt(authGroupEl.value, 10) : -1;
    var fromEnv = !isNaN(idx) && authGroupsData[idx] && authGroupsData[idx].envVarSet;
    var hasApiKey = fromEnv || (authSecretEl && authSecretEl.value.trim().length > 0);
    startSetupBtn.disabled = !hasApiKey;
  }

  function applyAuthSecretFromEnv() {
    if (!authSecretEl || !authSecretHintEl) return;
    var idx = authGroupEl ? parseInt(authGroupEl.value, 10) : -1;
    var fromEnv = !isNaN(idx) && authGroupsData[idx] && authGroupsData[idx].envVarSet;
    if (fromEnv) {
      authSecretEl.disabled = true;
      authSecretEl.classList.add('from-env');
      authSecretEl.placeholder = '';
      authSecretEl.value = '';
      authSecretHintEl.classList.remove('hidden');
    } else {
      authSecretEl.disabled = false;
      authSecretEl.classList.remove('from-env');
      authSecretEl.placeholder = 'Paste API key or token';
      authSecretHintEl.classList.add('hidden');
    }
    updateStartSetupEnabled();
  }

  function refreshStatus() {
    setStatus('Loading...', 'pending');
    setStartSetupLoading(true);
    return httpJson('/setup/api/status').then(function (j) {
      statusCheckInProgress = false;
      authGroupsData = j.authGroups || [];
      var ver = j.openclawVersion ? j.openclawVersion : '';
      if (j.configured) {
        setStatus('Ready' + (ver ? ' - ' + ver : ''), 'success');
      } else {
        setStatus('Setup required' + (ver ? ' - ' + ver : ''), 'pending');
      }
      renderAuth(authGroupsData);
      applyAuthSecretFromEnv();

      setStartSetupLoading(false);

      // Load config editor content
      if (configReloadEl && configTextEl) {
        loadConfigRaw();
      }
    }).catch(function (e) {
      statusCheckInProgress = false;
      setStatus('Error', 'error');
      setStartSetupLoading(false);
    });
  }

  // Debug console runner
  function runConsole() {
    if (!consoleCmdEl || !consoleRunEl) return;
    var cmd = consoleCmdEl.value;
    var arg = consoleArgEl ? consoleArgEl.value : '';
    if (consoleOutEl) {
      consoleOutEl.textContent = 'Running ' + cmd + '...\n';
      consoleOutEl.style.display = 'block';
    }

    return httpJson('/setup/api/console/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: cmd, arg: arg })
    }).then(function (j) {
      if (consoleOutEl) consoleOutEl.textContent = (j.output || JSON.stringify(j, null, 2));
      return refreshStatus();
    }).catch(function (e) {
      if (consoleOutEl) consoleOutEl.textContent += '\nError: ' + String(e) + '\n';
    });
  }

  if (consoleRunEl) {
    consoleRunEl.onclick = runConsole;
  }

  // Config raw load/save
  function loadConfigRaw() {
    if (!configTextEl) return;
    if (configOutEl) configOutEl.style.display = 'none';
    return httpJson('/setup/api/config/raw').then(function (j) {
      if (configPathEl) {
        configPathEl.textContent = (j.path || '(unknown)') + (j.exists ? '' : ' (new)');
      }
      configTextEl.value = j.content || '';
    }).catch(function (e) {
      if (configOutEl) {
        configOutEl.textContent = 'Error loading config: ' + String(e);
        configOutEl.style.display = 'block';
      }
    });
  }

  function saveConfigRaw() {
    if (!configTextEl) return;
    if (!confirm('Save config and restart gateway?')) return;
    if (configOutEl) {
      configOutEl.textContent = 'Saving...\n';
      configOutEl.style.display = 'block';
    }
    return httpJson('/setup/api/config/raw', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: configTextEl.value })
    }).then(function (j) {
      if (configOutEl) configOutEl.textContent = 'Saved. Gateway restarted.\n';
      return refreshStatus();
    }).catch(function (e) {
      if (configOutEl) configOutEl.textContent += '\nError: ' + String(e) + '\n';
    });
  }

  if (configReloadEl) configReloadEl.onclick = loadConfigRaw;
  if (configSaveEl) configSaveEl.onclick = saveConfigRaw;

  // Import backup
  function runImport() {
    if (!importRunEl || !importFileEl) return;
    var f = importFileEl.files && importFileEl.files[0];
    if (!f) {
      alert('Pick a .tar.gz file first');
      return;
    }
    if (!confirm('Import backup? This overwrites files and restarts the gateway.')) return;

    if (importOutEl) {
      importOutEl.textContent = 'Uploading ' + f.name + '...\n';
      importOutEl.style.display = 'block';
    }

    return f.arrayBuffer().then(function (buf) {
      return fetch('/setup/import', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/gzip' },
        body: buf
      });
    }).then(function (res) {
      return res.text().then(function (t) {
        if (importOutEl) importOutEl.textContent += t + '\n';
        if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + t);
        return refreshStatus();
      });
    }).catch(function (e) {
      if (importOutEl) importOutEl.textContent += '\nError: ' + String(e) + '\n';
    });
  }

  if (importRunEl) importRunEl.onclick = runImport;

  // Reset button
  var resetBtn = document.getElementById('reset');
  if (resetBtn) {
    resetBtn.onclick = function () {
      if (!confirm('Reset setup? This deletes the config file.')) return;
      showLog('Resetting...\n');
      fetch('/setup/api/reset', { method: 'POST', credentials: 'same-origin' })
        .then(function (res) { return res.text(); })
        .then(function (t) {
          appendLog(t + '\n');
          // Restore UI to initial state so setup can be rerun
          convosJoined = false;
          if (startSetupBtn) {
            startSetupBtn.style.display = '';
            startSetupBtn.disabled = false;
            startSetupBtn.textContent = 'Start Setup';
          }
          if (completeSetupBtn) completeSetupBtn.style.display = 'none';
          var qrImg = document.getElementById('convos-qr');
          if (qrImg) qrImg.style.display = 'none';
          var qrWrap = document.getElementById('convos-qr-wrap');
          if (qrWrap) { qrWrap.innerHTML = ''; qrWrap.style.display = 'none'; }
          var qrInfoEl = document.getElementById('qr-info');
          if (qrInfoEl) qrInfoEl.style.display = 'none';
          var loadingEl = document.getElementById('convos-loading');
          if (loadingEl) {
            var t = document.getElementById('snippet-loading-idle');
            loadingEl.innerHTML = t ? t.innerHTML : '';
            loadingEl.style.display = '';
          }
          return refreshStatus();
        })
        .catch(function (e) { appendLog('Error: ' + String(e) + '\n'); });
    };
  }

  // Start Setup - runs onboarding, starts gateway, calls convos.setup RPC
  function runStartSetup() {
    if (!startSetupBtn) return;

    hideError();

    var payload = {
      authGroup: authGroupEl ? authGroupEl.value : '',
      authSecret: document.getElementById('authSecret') ? document.getElementById('authSecret').value : ''
    };

    startSetupBtn.disabled = true;
    startSetupBtn.classList.add('loading');
    var btnTpl = document.getElementById('snippet-btn-loading');
    startSetupBtn.innerHTML = btnTpl ? btnTpl.innerHTML : 'Loading...';
    setStatus('Loading...', 'pending');
    showLog('Starting onboarding...\n');

    var loadingEl = document.getElementById('convos-loading');
    if (loadingEl) {
      var runTpl = document.getElementById('snippet-loading-running');
      loadingEl.innerHTML = runTpl ? runTpl.innerHTML : '';
    }

    httpJson('/setup/api/convos/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (data) {
      if (!data.success) {
        throw new Error(data.error || 'Setup failed');
      }

      appendLog('Convos invite created. Waiting for join...\n');

      // Hide loading
      if (loadingEl) loadingEl.style.display = 'none';

      // Generate QR on client from invite URL (qrcodejs: renders into element)
      var qrImg = document.getElementById('convos-qr');
      var qrWrap = document.getElementById('convos-qr-wrap');
      if (data.inviteUrl && typeof QRCode !== 'undefined' && qrWrap) {
        try {
          qrWrap.innerHTML = '';
          new QRCode(qrWrap, { text: data.inviteUrl, width: 200, height: 200 });
          qrWrap.style.display = 'block';
          if (qrImg) qrImg.style.display = 'none';
        } catch (err) {
          console.warn('[convos-setup] QR generation failed:', err);
        }
      } else if (!data.inviteUrl) {
        // no invite URL
      } else if (typeof QRCode === 'undefined') {
        console.warn('[convos-setup] QR script failed to load; QR not shown');
      }

      // Show QR info section
      var qrInfoEl = document.getElementById('qr-info');
      if (qrInfoEl) qrInfoEl.style.display = 'block';

      // Show invite URL
      var inviteUrlEl = document.getElementById('convos-invite-url');
      if (inviteUrlEl) {
        inviteUrlEl.textContent = data.inviteUrl;
        inviteUrlEl.style.display = 'block';
      }

      // Hide start button, update status
      startSetupBtn.style.display = 'none';
      setStatus('Waiting for join...', 'pending');

      // Poll for join status
      var pollInterval = setInterval(function () {
        httpJson('/setup/api/convos/join-status').then(function (state) {
          if (state.joined && !convosJoined) {
            convosJoined = true;
            clearInterval(pollInterval);

            // Update join status badge
            var joinStatusEl = document.getElementById('join-status');
            if (joinStatusEl) {
              joinStatusEl.textContent = 'Joined';
              joinStatusEl.className = 'qr-info-value status joined';
            }

            // Show the Finish Setup button
            if (completeSetupBtn) {
              completeSetupBtn.style.display = 'block';
            }

            setStatus('User joined - ready to finish', 'success');
          }
        }).catch(function () {
          // Ignore polling errors
        });
      }, 3000);

      // Stop polling after 5 minutes
      setTimeout(function () {
        clearInterval(pollInterval);
      }, 300000);
    }).catch(function (err) {
      if (loadingEl) {
        var errTpl = document.getElementById('snippet-loading-error');
        loadingEl.innerHTML = errTpl ? errTpl.innerHTML : '';
        var msgEl = loadingEl.querySelector('.snippet-error-message');
        if (msgEl) msgEl.textContent = 'Error: ' + err.message;
      }
      showError(err.message);
      startSetupBtn.classList.remove('loading');
      startSetupBtn.textContent = 'Start Setup';
      updateStartSetupEnabled();
      refreshStatus();
    });
  }

  // Finish Setup - calls convos.setup.complete RPC
  function runCompleteSetup() {
    if (!completeSetupBtn) return;

    hideError();
    completeSetupBtn.disabled = true;
    completeSetupBtn.textContent = 'Completing setup...';
    showLog('Finalizing Convos configuration...\n');

    httpJson('/setup/api/convos/complete-setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    }).then(function (data) {
      if (data.ok) {
        appendLog('Setup complete!\n');
        completeSetupBtn.textContent = 'Setup Complete!';
        completeSetupBtn.classList.add('success');
        setStatus('Ready', 'success');
      } else {
        showError(data.error || 'Setup failed');
        completeSetupBtn.disabled = false;
        completeSetupBtn.textContent = 'Finish Setup';
      }
      return refreshStatus();
    }).catch(function (err) {
      appendLog('\nError: ' + String(err) + '\n');
      showError(String(err));
      completeSetupBtn.disabled = false;
      completeSetupBtn.textContent = 'Finish Setup';
    });
  }

  if (startSetupBtn) startSetupBtn.onclick = runStartSetup;
  if (completeSetupBtn) completeSetupBtn.onclick = runCompleteSetup;

  if (authSecretEl) {
    authSecretEl.addEventListener('input', updateStartSetupEnabled);
    authSecretEl.addEventListener('change', updateStartSetupEnabled);
  }
  if (authGroupEl) {
    authGroupEl.addEventListener('change', applyAuthSecretFromEnv);
  }

  // Initial load
  setStartSetupLoading(true);
  refreshStatus();

  // Only show "Already configured" when Convos channel is actually set up,
  // not just because a config file exists from onboarding.
  httpJson('/setup/api/status').then(function (data) {
    if (data.convosConfigured) {
      var loadingEl = document.getElementById('convos-loading');
      if (loadingEl) {
        var doneTpl = document.getElementById('snippet-already-configured');
        loadingEl.innerHTML = doneTpl ? doneTpl.innerHTML : '';
      }
      if (startSetupBtn) startSetupBtn.style.display = 'none';
      setStatus('Ready', 'success');
    }
  }).catch(function () {
    // Ignore - status will be loaded by refreshStatus
  });
})();
