(function () {
  'use strict';

  var script = document.currentScript;
  var portalOrigin = '';
  try {
    portalOrigin = new URL(script && script.src ? script.src : window.location.href).origin;
  } catch (e) {
    return;
  }

  var params = new URLSearchParams(window.location.search);
  var campaignToken = params.get('vq');
  if (!campaignToken) return;

  function cleanDeviceKey(value) {
    value = String(value || '').trim();
    if (!value || value.indexOf('$(') !== -1) return '';
    return value.toLowerCase();
  }

  function findDeviceKey() {
    var candidates = [
      document.querySelector('#mac2'),
      document.querySelector('input[name="mac"]'),
      document.querySelector('[data-hotspot-mac]')
    ];
    for (var i = 0; i < candidates.length; i++) {
      if (!candidates[i]) continue;
      var value = cleanDeviceKey(candidates[i].value || candidates[i].getAttribute('data-hotspot-mac'));
      if (value) return value;
    }
    return '';
  }

  function showOverlay(message, error) {
    var existing = document.getElementById('vq-auto-overlay');
    if (existing) existing.remove();
    var overlay = document.createElement('div');
    overlay.id = 'vq-auto-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(5,8,13,.92);display:flex;align-items:center;justify-content:center;padding:24px;font-family:Arial,sans-serif;color:white;text-align:center;';
    var card = document.createElement('div');
    card.style.cssText = 'width:min(92vw,390px);padding:26px;border-radius:22px;background:#111722;border:1px solid rgba(255,255,255,.1);box-shadow:0 25px 80px rgba(0,0,0,.45);';
    var title = document.createElement('div');
    title.textContent = error ? 'Unable to connect' : 'Connecting you…';
    title.style.cssText = 'font-size:22px;font-weight:800;margin-bottom:10px;';
    var body = document.createElement('div');
    body.textContent = message;
    body.style.cssText = 'font-size:14px;line-height:1.5;color:' + (error ? '#ff9aa8' : '#aab6c7') + ';';
    card.appendChild(title);
    card.appendChild(body);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  function waitForHotspotReady(callback, attempts) {
    attempts = attempts || 0;
    var code = document.querySelector('#code');
    var button = document.querySelector('#voucher-form');
    var deviceKey = findDeviceKey();
    if (code && button && deviceKey) return callback(code, button, deviceKey);
    if (attempts >= 40) return showOverlay('The hotspot login page did not become ready. Please open the normal login page and try again.', true);
    setTimeout(function () { waitForHotspotReady(callback, attempts + 1); }, 250);
  }

  function claimAndActivate(codeInput, activateButton, deviceKey) {
    showOverlay('Assigning an internet voucher to this device.', false);
    fetch(portalOrigin + '/api/v1/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaign_token: campaignToken, device_key: deviceKey })
    })
      .then(function (response) {
        return response.json().then(function (body) {
          if (!response.ok) throw new Error(body.error || 'Voucher assignment failed');
          return body;
        });
      })
      .then(function (result) {
        codeInput.value = result.voucher;
        var overlay = document.getElementById('vq-auto-overlay');
        if (overlay) overlay.remove();
        setTimeout(function () { activateButton.click(); }, 900);
      })
      .catch(function (error) {
        showOverlay(error.message || 'Unable to assign a voucher. Please try again.', true);
      });
  }

  window.addEventListener('DOMContentLoaded', function () {
    waitForHotspotReady(claimAndActivate, 0);
  });
})();
