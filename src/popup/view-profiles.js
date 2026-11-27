/* 岗位雷达 · popup 视图：判定标准
 * 左列表 + 右编辑器。编辑态改动未保存时切走会提示，避免"改一半丢了但版本号没动"。
 */
(function () {
  'use strict';

  var U = window.JR_UTIL;

  var profiles = [];
  var activeId = '';
  var editingId = null;   // null = 新建
  var dirty = false;
  var busy = false;
  var inited = false;

  var el = {};

  function send(msg) {
    return window.JR_POPUP.send(msg);
  }

  function pick(id) {
    for (var i = 0; i < profiles.length; i++) if (profiles[i].id === id) return profiles[i];
    return null;
  }

  function setMsg(text, tone) {
    el.msg.textContent = text || '';
    el.msg.className = 'msg' + (tone ? ' ' + tone : '');
  }

  function renderList() {
    if (!profiles.length) {
      el.items.innerHTML = '';
      el.listHint.textContent = '还没有标准。点「新建」写第一条。';
      return;
    }
    el.items.innerHTML = profiles.map(function (p) {
      var on = p.id === activeId;
      var cls = 'pf-item' + (p.id === editingId ? ' active' : '');
      return '<div class="' + cls + '" data-id="' + U.escapeHtml(p.id) + '">' +
        '<div class="pf-item-name">' + U.escapeHtml(p.name) + '</div>' +
        '<div class="pf-item-meta">v' + (p.version || 1) +
        (on ? ' · <span class="on">当前生效</span>' : '') + '</div>' +
        '</div>';
    }).join('');
    el.listHint.textContent = profiles.length + ' 条标准';
  }

  function showEmpty() {
    el.empty.style.display = 'block';
    el.form.style.display = 'none';
    el.items.innerHTML = '';
    el.listHint.textContent = '还没有标准。点「新建」写第一条。';
  }

  function fillForm(p) {
    el.empty.style.display = 'none';
    el.form.style.display = 'block';
    el.name.value = p ? p.name : '';
    el.req.value = p ? p.requirement : '';
    el.must.value = p ? (p.mustHave || '') : '';
    el.red.value = p ? (p.redFlags || '') : '';
    el.title.textContent = p ? '编辑标准' : '新建标准';
    el.ver.textContent = p ? 'v' + (p.version || 1) : '未保存';
    el.del.style.display = p ? 'inline-block' : 'none';
    dirty = false;
    setMsg('');
  }

  function select(id, checkDirty) {
    if (checkDirty !== false && dirty && !busy) {
      if (!confirm('当前修改还没保存，确定切走？')) return;
    }
    if (!id) {
      editingId = null;
      renderList();
      fillForm(null);
      el.name.focus();
      return;
    }
    var p = pick(id);
    if (!p) return;
    editingId = p.id;
    renderList();
    fillForm(p);
  }

  function load(keepEditing) {
    return send({ type: 'PROFILE_ACTIVE' }).then(function (res) {
      if (!res.ok) throw new Error(res.error || '读取标准失败');
      profiles = res.list || [];
      activeId = res.profile ? res.profile.id : '';

      if (!profiles.length) {
        editingId = null;
        showEmpty();
        return;
      }

      var want = keepEditing && editingId ? editingId : (activeId || profiles[0].id);
      if (!pick(want)) want = profiles[0].id;
      editingId = want;
      renderList();
      fillForm(pick(want));
    }).catch(function (e) {
      setMsg(e.message || String(e), 'bad');
      el.empty.style.display = 'block';
      el.empty.innerHTML = '<b>读取判定标准失败</b>' + U.escapeHtml(e.message || '');
    });
  }

  function readForm() {
    return {
      id: editingId || undefined,
      name: el.name.value,
      requirement: el.req.value,
      mustHave: el.must.value,
      redFlags: el.red.value
    };
  }

  function onSave(e) {
    e.preventDefault();
    if (busy) return;

    var payload = readForm();
    busy = true;
    el.save.disabled = true;
    setMsg('保存中…');

    send({ type: 'PROFILES_SAVE', profile: payload }).then(function (res) {
      busy = false;
      el.save.disabled = false;
      if (!res.ok) {
        setMsg(res.error || '保存失败', 'bad');
        return;
      }
      editingId = res.record.id;
      dirty = false;
      return load(true).then(function () {
        /* load 里的 fillForm 会清空提示，所以成功文案要放在它之后 */
        setMsg('已保存（v' + res.record.version + '），下次判定生效', 'ok');
      });
    }).catch(function (err) {
      busy = false;
      el.save.disabled = false;
      setMsg(err.message || '保存失败', 'bad');
    });
  }

  function onDelete() {
    if (!editingId || busy) return;
    var p = pick(editingId);
    if (!p) return;
    if (!confirm('删除判定标准「' + p.name + '」？\n\n已产生的判定结果会保留，但无法再用这条标准重跑。')) return;

    busy = true;
    send({ type: 'PROFILES_DELETE', id: editingId }).then(function (res) {
      busy = false;
      if (!res.ok) {
        setMsg(res.error || '删除失败', 'bad');
        return;
      }
      editingId = null;
      dirty = false;
      return load(false);
    }).catch(function (err) {
      busy = false;
      setMsg(err.message || '删除失败', 'bad');
    });
  }

  function markDirty() {
    dirty = true;
    setMsg('有未保存的修改', 'warn');
  }

  function bind() {
    el.items.addEventListener('click', function (e) {
      var node = e.target.closest ? e.target.closest('.pf-item') : null;
      if (!node) return;
      var id = node.getAttribute('data-id');
      if (id && id !== editingId) select(id, true);
    });

    el.newBtn.addEventListener('click', function () { select(null, true); });
    el.form.addEventListener('submit', onSave);
    el.del.addEventListener('click', onDelete);

    [el.name, el.req, el.must, el.red].forEach(function (node) {
      node.addEventListener('input', markDirty);
    });
  }

  function init() {
    if (inited) return;
    inited = true;

    el = {
      items: document.getElementById('pfItems'),
      listHint: document.getElementById('pfListHint'),
      empty: document.getElementById('pfEmpty'),
      form: document.getElementById('pfForm'),
      title: document.getElementById('pfTitle'),
      ver: document.getElementById('pfVer'),
      name: document.getElementById('pfName'),
      req: document.getElementById('pfReq'),
      must: document.getElementById('pfMust'),
      red: document.getElementById('pfRed'),
      save: document.getElementById('pfSave'),
      del: document.getElementById('pfDelete'),
      msg: document.getElementById('pfMsg'),
      newBtn: document.getElementById('pfNew')
    };

    bind();
    load(false);
  }

  function onShow() {
    if (!profiles.length) load(false);
  }

  window.JR_VIEW_PROFILES = {
    init: init,
    onShow: onShow,
    reload: function () { return load(true); }
  };
})();
