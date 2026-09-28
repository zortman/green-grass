(function () {
  'use strict';

  var gate = document.getElementById('green-grass-gate');
  var form = document.getElementById('gg-gate-form');
  var input = document.getElementById('gg-gate-input');
  var error = document.getElementById('gg-gate-error');

  if (!gate || !form || !input) return;

  function unlock() {
    error.classList.remove('show');
    gate.classList.add('gg-gate-hidden');

    window.setTimeout(function () {
      if (gate && gate.parentNode) gate.parentNode.removeChild(gate);
    }, 450);
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();

    if (input.value.trim() === '1111') {
      unlock();
      return;
    }

    error.textContent = 'No results found.';
    error.classList.add('show');
    input.select();

    window.setTimeout(function () {
      error.classList.remove('show');
    }, 1600);
  });

  window.setTimeout(function () {
    input.focus();
  }, 0);
})();
