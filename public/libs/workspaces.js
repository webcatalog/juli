/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
const { app } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const settings = require('electron-settings');
const {
  v1: uuidv1,
  v5: uuidv5,
} = require('uuid');
const Jimp = require('jimp');
const isUrl = require('is-url');
const tmp = require('tmp');

const sendToAllWindows = require('./send-to-all-windows');
const downloadAsync = require('./download-async');

const appJson = require('../app.json');

const ACCOUNT_PICTURE_PATH_UUID_NAMESPACE = '777ebe80-28ec-11eb-b7fe-6be41598616a';

const v = '43';

let workspaces;

const initWorkspaces = () => {
  if (workspaces) return;

  const loadedWorkspaces = settings.getSync(`workspaces.${v}`) || {};
  // remove corrupted data caused by v11.4.0
  if ('add' in loadedWorkspaces) {
    delete loadedWorkspaces.add;
  }

  // legacy (v=14 was used for Singlebox prior to merging with Juli)
  // Singlebox v1-v3
  if (appJson.id === 'singlebox') {
    const legacySingleboxV = '14';
    const legacyWorkspaces = settings.getSync(`workspaces.${legacySingleboxV}`);
    if (legacyWorkspaces) {
      Object.assign(loadedWorkspaces, legacyWorkspaces);
      settings.setSync(`workspaces.${v}`, loadedWorkspaces);
      settings.unset(`workspaces.${legacySingleboxV}`);
    }
  }

  if (appJson.url && Object.keys(loadedWorkspaces).length < 1) {
    const initialWorkspaceId = uuidv1();
    loadedWorkspaces[initialWorkspaceId] = {
      id: initialWorkspaceId,
      name: '',
      order: 0,
      active: true,
    };
    settings.setSync(`workspaces.${v}`, loadedWorkspaces);
  }

  // keep workspace objects in memory
  workspaces = loadedWorkspaces;
};

const countWorkspaces = () => {
  initWorkspaces();
  return Object.keys(workspaces).length;
};

const getWorkspaces = () => {
  initWorkspaces();
  return workspaces;
};

const getWorkspacesAsList = () => {
  const workspaceLst = Object.values(getWorkspaces())
    .sort((a, b) => a.order - b.order);

  return workspaceLst;
};

const getWorkspace = (id) => {
  initWorkspaces();
  return workspaces[id];
};

const getWorkspacePreferences = (id) => {
  const { preferences } = getWorkspace(id) || {};
  return preferences || {};
};

const getWorkspacePreference = (id, preferenceName) => {
  const preferences = getWorkspacePreferences(id);
  return preferences[preferenceName];
};

const getPreviousWorkspace = (id) => {
  const workspaceLst = getWorkspacesAsList();

  let currentWorkspaceI = 0;
  for (let i = 0; i < workspaceLst.length; i += 1) {
    if (workspaceLst[i].id === id) {
      currentWorkspaceI = i;
      break;
    }
  }

  if (currentWorkspaceI === 0) {
    return workspaceLst[workspaceLst.length - 1];
  }
  return workspaceLst[currentWorkspaceI - 1];
};

const getNextWorkspace = (id) => {
  const workspaceLst = getWorkspacesAsList();

  let currentWorkspaceI = 0;
  for (let i = 0; i < workspaceLst.length; i += 1) {
    if (workspaceLst[i].id === id) {
      currentWorkspaceI = i;
      break;
    }
  }

  if (currentWorkspaceI === workspaceLst.length - 1) {
    return workspaceLst[0];
  }
  return workspaceLst[currentWorkspaceI + 1];
};

const createWorkspace = (workspaceObj = {}) => {
  const newId = uuidv1();

  // find largest order
  const workspaceLst = getWorkspacesAsList();
  let max = 0;
  for (let i = 0; i < workspaceLst.length; i += 1) {
    if (workspaceLst[i].order > max) {
      max = workspaceLst[i].order;
    }
  }

  const newWorkspace = {
    active: false,
    hibernated: false,
    id: newId,
    name: workspaceObj.name || '',
    order: max + 1,
    ...workspaceObj,
  };
  delete newWorkspace.picture;

  workspaces[newId] = newWorkspace;

  sendToAllWindows('set-workspace', newId, newWorkspace);
  settings.setSync(`workspaces.${v}.${newId}`, newWorkspace);

  return newWorkspace;
};

const getActiveWorkspace = () => {
  if (!workspaces) return null;
  return Object.values(workspaces).find((workspace) => workspace.active);
};

const setActiveWorkspace = (id) => {
  // deactive the current one
  let currentActiveWorkspace = getActiveWorkspace();
  if (currentActiveWorkspace) {
    if (currentActiveWorkspace.id === id) return;
    currentActiveWorkspace = { ...currentActiveWorkspace };
    currentActiveWorkspace.active = false;
    workspaces[currentActiveWorkspace.id] = currentActiveWorkspace;
    sendToAllWindows('set-workspace', currentActiveWorkspace.id, currentActiveWorkspace);
    settings.setSync(`workspaces.${v}.${currentActiveWorkspace.id}`, currentActiveWorkspace);
  }

  // active new one
  const newActiveWorkspace = { ...workspaces[id] };
  newActiveWorkspace.active = true;
  newActiveWorkspace.hibernated = false;
  workspaces[id] = newActiveWorkspace;
  sendToAllWindows('set-workspace', id, newActiveWorkspace);
  settings.setSync(`workspaces.${v}.${id}`, newActiveWorkspace);
};

const setWorkspace = (id, opts) => {
  const workspace = { ...workspaces[id], ...opts };
  workspaces[id] = workspace;
  sendToAllWindows('set-workspace', id, workspace);
  settings.setSync(`workspaces.${v}.${id}`, workspace);
};

const setWorkspaces = (newWorkspaces) => {
  workspaces = newWorkspaces;
  sendToAllWindows('set-workspaces', newWorkspaces);
  settings.setSync(`workspaces.${v}`, newWorkspaces);
};

const setWorkspacePicture = (id, sourcePicturePath) => {
  const workspace = getWorkspace(id);
  const pictureId = uuidv1();

  if (workspace.picturePath === sourcePicturePath) {
    return;
  }

  const destPicturePath = path.join(app.getPath('userData'), 'pictures', `${pictureId}.png`);

  Promise.resolve()
    .then(() => {
      if (isUrl(sourcePicturePath)) {
        const tmpObj = tmp.dirSync();
        const tmpPath = tmpObj.name;
        return downloadAsync(sourcePicturePath, path.join(tmpPath, 'e.png')).then(() => path.join(tmpPath, 'e.png'));
      }

      return sourcePicturePath;
    })
    .then((picturePath) => Jimp.read(picturePath))
    .then((img) => new Promise((resolve) => {
      img.clone()
        .resize(128, 128)
        .quality(100)
        .write(destPicturePath, resolve);
    }))
    .then(() => {
      const currentPicturePath = getWorkspace(id).picturePath;
      setWorkspace(id, {
        pictureId,
        picturePath: destPicturePath,
      });
      if (currentPicturePath) {
        return fs.remove(currentPicturePath);
      }
      return null;
    });
};

const removeWorkspacePicture = (id) => {
  const workspace = getWorkspace(id);
  if (workspace.picturePath) {
    return fs.remove(workspace.picturePath)
      .then(() => {
        setWorkspace(id, {
          pictureId: null,
          picturePath: null,
        });
      });
  }
  return Promise.resolve();
};

const setWorkspaceAccountInfo = (id, accountInfo) => {
  const workspace = getWorkspace(id);
  if (!workspace) return Promise.resolve();
  const currentAccountInfo = workspace.accountInfo || {};
  if (currentAccountInfo.pictureUrl === accountInfo.pictureUrl
    && currentAccountInfo.name === accountInfo.name
    && currentAccountInfo.email === accountInfo.email) {
    // nothing changes
    return Promise.resolve();
  }

  const newAccountInfo = { ...accountInfo };
  return Promise.resolve()
    .then(() => {
      const pictureId = uuidv5(accountInfo.pictureUrl, ACCOUNT_PICTURE_PATH_UUID_NAMESPACE);
      if (currentAccountInfo.pictureUrl !== accountInfo.pictureUrl && accountInfo.pictureUrl) {
        const picturePath = path.join(app.getPath('userData'), 'account-pictures', `${pictureId}.png`);
        return downloadAsync(accountInfo.pictureUrl, picturePath)
          .then(() => {
            newAccountInfo.pictureId = pictureId;
            newAccountInfo.picturePath = picturePath;
          });
      }
      return null;
    })
    .then(() => {
      setWorkspace(id, {
        accountInfo: newAccountInfo,
      });
    })
    // eslint-disable-next-line no-console
    .catch(console.log);
};

const removeWorkspaceAccountInfo = (id) => {
  const workspace = getWorkspace(id);
  return Promise.resolve()
    .then(() => {
      setWorkspace(id, {
        accountInfo: null,
      });
      if (workspace.accountInfo && workspace.accountInfo.picturePath) {
        return fs.remove(workspace.accountInfo.picturePath);
      }
      return null;
    });
};

const removeWorkspace = (id) => {
  const workspace = workspaces[id];

  delete workspaces[id];
  sendToAllWindows('set-workspace', id, null);
  settings.unsetSync(`workspaces.${v}.${id}`);

  // remove workspace data from disk
  fs.remove(path.join(app.getPath('userData'), 'Partitions', id))
    .then(() => {
      const p = [];
      if (workspace && workspace.picturePath) {
        p.push(fs.remove(workspace.picturePath));
      }
      if (workspace && workspace.accountInfo && workspace.accountInfo.picturePath) {
        p.push(fs.remove(workspace.accountInfo.picturePath));
      }
      return Promise.all(p);
    })
    .then(() => {
      // eslint-disable-next-line no-console
      console.log('Removed workspace data:', id);
    })
    .catch((err) => {
      // ignore the error as it doesn't affect the experience
      // eslint-disable-next-line no-console
      console.log(err);
    });
};

module.exports = {
  countWorkspaces,
  createWorkspace,
  getActiveWorkspace,
  getNextWorkspace,
  getPreviousWorkspace,
  getWorkspace,
  getWorkspacePreference,
  getWorkspacePreferences,
  getWorkspaces,
  getWorkspacesAsList,
  removeWorkspace,
  removeWorkspaceAccountInfo,
  removeWorkspacePicture,
  setActiveWorkspace,
  setWorkspace,
  setWorkspaceAccountInfo,
  setWorkspacePicture,
  setWorkspaces,
};
