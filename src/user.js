const ssha = require('node-ssha256');
const api = require('./util/api');
const encodePassword = require('./util/encodePassword');
const wrapAsync = require('./util/wrapAsync');
const parseLocation = require('./util/parseLocation');

/**
 *  Public user functions
 *  --------------------------
 *  findUser(userName, opts)
 *  addUser(opts, stopManipulation)
 *  updateUser(userName, opts, stopManipulation)
 *  userExists(userName)
 *  userIsMemberOf(userName, groupName)
 *  authenticateUser(userName, pass)
 *  setUserPassword(userName, pass)
 *  setUserPasswordNeverExpires(userName)
 *  enableUser(userName)
 *  disableUser(userName)
 *  moveUser(userName, location)
 *  getUserLocation(userName)
 *  unlockUser(userName)
 *  removeUser(userName)
 */

module.exports = {
  async getAllUsers(opts) {
    return await this._findByType(opts, ['user']);
  },

  async addUser(opts, stopManipulation) {
    return new Promise(async (resolve, reject) => {
      stopManipulation = typeof stopManipulation === 'undefined' ? false : true;
      const userAttrs = this.attrs.user.writable;
      const map = {
        firstName: 'givenName',
        lastName: 'sn',
        password: 'unicodePwd',
        commonName: 'cn',
        email: 'mail',
        objectClass: 'objectClass',
        userName: 'sAMAccountName',
        phone: 'telephoneNumber'
      };

      const ignoreMap = [
        'location', 
        'passwordexpires', 
        'enabled'
      ];

      let userObject = {};

      for (let key in opts) {
        let lowerCaseKey = key.toLowerCase();
        if (ignoreMap.indexOf(lowerCaseKey) >= 0) {
          continue;
        }

        if (userAttrs.indexOf(lowerCaseKey) >= 0) {
          userObject[lowerCaseKey] = opts[key];
        } else {
          let name = map[key];
          if (name === undefined) {
            return reject({ error: true, message: `Invalid adUser attribute '${key}'`, httpStatus: 400 });
          } else {
            userObject[name.toLowerCase()] = opts[key];
          }
        }
      }
      
      const {
        givenname,
        sn,
        cn,
        samaccountname,
        unicodepwd,
        mail
      } = userObject;
      const { 
        location,
        passwordExpires,
        enabled
      } = opts;
      const userName = samaccountname;
      const password = unicodepwd;

      if (!stopManipulation) {
        if (cn) {
          const cnParts = String(cn).split(' ');
          givenname = givenname ? givenname : cnParts[0];
          if (cnParts.length > 1) {
            sn = sn ? sn : cnParts[cnParts.length - 1];
          }
        } else {
          if (givenname && sn) {
            cn = `${givenname} ${sn}`;
          }
        }
      }

      let valid =
        mail && String(mail).indexOf('@') === -1
          ? 'Invalid email address.'
          : !cn
            ? 'A commonName is required.'
            : !userName ? 'A userName is required.' : true;

      if (valid !== true) {
        /* istanbul ignore next */
        return reject({ error: true, message: valid, httpStatus: 400 });
      }

      let errorMessage = '';
      if(password !== undefined && password.trim() !== ''){ 
        userObject.userPassword = ssha.create(password);
      }else{
        if(enabled !== undefined){
          errorMessage = 'Password is required to enable account';
        }else if (passwordExpires !== undefined){
          errorMessage = 'Password is required to set password never expires';
        }
      }

      if(errorMessage !== ''){
        /* istanbul ignore next */
        return reject({ error: true, message: errorMessage, httpStatus: 400 });
      }

      if (!stopManipulation) {
        userObject.uid = userName;
        userObject.cn = cn;
        userObject.givenname = givenname;
        userObject.sn = sn;
        userObject.userprincipalname = `${userName}@${this.config.domain}`;
      }

      userObject.objectclass = this.config.defaults.userObjectClass;
      const orgUnit = parseLocation(location);
      delete userObject.unicodepwd;

      this._addObject(`CN=${cn}`, orgUnit, userObject)
        .then(response => {
          delete userObject.userPassword;
          delete this._cache.users[userName];
          this._cache.all = {};

          if(password !== undefined && password.trim() !== ''){
            const ENABLED = 512;
            const DISABLED = 514;
            const NEVER_EXPIRES = 66048;
            let operations = [];

            operations.push({
              unicodePwd: encodePassword(password)
            });

            if (passwordExpires !== undefined) {
              operations.push({
                userAccountControl: NEVER_EXPIRES
              });
            }else if(enabled === false){
              operations.push({
                userAccountControl: DISABLED
              });
            }else {
              operations.push({
                userAccountControl: ENABLED
              });
            }

            this.setUserProperties(userName, operations)
            .then(data => {
              delete this._cache.users[userName];
              return resolve(userObject);
            })
            .catch(err => {
              return reject(err);
            });
          }else{
            return resolve(userObject);
          }
        })
        .catch(err => {
          /* istanbul ignore next */
          const ENTRY_EXISTS = String(err.message).indexOf('ENTRY_EXISTS') > -1;
          /* istanbul ignore next */
          if (ENTRY_EXISTS) {
            /* istanbul ignore next */
            return reject({
              message: `User ${userName} already exists.`,
              httpStatus: 400
            });
          }
          /* istanbul ignore next */
          return reject({
            message: `Error creating user: ${err.message}`,
            httpStatus: 503
          });
        });
    });
  },

  async updateUser(userName, opts, stopManipulation) {
    return new Promise((resolve, reject) => {
      stopManipulation = typeof stopManipulation === 'undefined' ? false : true;
      const domain = this.config.domain;
      const userAttrs = this.attrs.user.writable;
      const map = {
        firstName: 'givenName',
        lastName: 'sn',
        password: 'unicodePwd',
        commonName: 'cn',
        cn: 'cn',
        email: 'mail',
        title: 'title',
        objectClass: 'objectClass',
        userName: 'sAMAccountName'
      };

      const ignoreMap = [
        'cn',
        'dn',
        'enabled',
        'groups',
        'ismemberof',
        'location',
        'passwordexpires',
        'unicodepwd',
        'whencreated'
      ];

      let userObject = {};
      let later = [];
      let operations = [];
      for (const name in opts) {
        if (map[name] !== undefined) {
          let key = map[name];
          let value =
            name === 'password' ? encodePassword(opts[name]) : opts[name];
          if (key !== 'cn') {
            if (!stopManipulation && key === 'sAMAccountName') {
              later.push({
                sAMAccountName: value
              });
              later.push({
                uid: value
              });
              later.push({
                userPrincipalName: `${value}@${domain}`
              });

              userObject.samaccountname = value;
              userObject.uid = value;
              userObject.userprincipalname = value;
            } else {
              operations.push({
                [key]: value
              });
              userObject[key.toLowerCase()] = value;
            }
          }else{
            userObject.cn = value;
          }
        } else {
          let lowerCaseKey = name.toLowerCase();
          if (ignoreMap.indexOf(lowerCaseKey) === -1) {
            if (userAttrs.indexOf(lowerCaseKey) >= 0) {
              let value = opts[name];
              operations.push({
                [name]: value
              });
              userObject[lowerCaseKey] = value;
            }else{
              return reject({ error: true, message: `Invalid adUser attribute '${name}'`, httpStatus: 400 });
            }
          }
        }
      }

      operations = operations.concat(later);
      let currUserName = userName;

      const go = () => {
        if (operations.length < 1) {
          delete this._cache.users[currUserName];
          delete this._cache.users[userName];
          resolve(userObject);
          return;
        }
        //let next = operations.pop();
        this.setUserProperties(currUserName, operations)
          .then(res => {
            if (userObject.userprincipalname !== undefined) {
              currUserName = userObject.userprincipalname;
            }
            //delete this._cache.users[currUserName];
            operations = [];
            go();
          })
          .catch(err => {
            return reject(err);
          });
      };

      this.findUser(currUserName)
        .then(data => {
          if (userObject.cn !== undefined && userObject.cn.toLowerCase() !== data.cn.toLowerCase()) {
            return this.setUserCN(currUserName, userObject.cn);
          }
        })
        .then(data => {
          let expirationMethod =
            opts.passwordExpires === false
              ? 'setUserPasswordNeverExpires'
              : 'enableUser';
          if (opts.passwordExpires !== undefined) {
            return this[expirationMethod](userName);
          }
        })
        .then(data => {
          let enableMethod =
            opts.enabled === false ? 'disableUser' : 'enableUser';
          if (opts.enabled !== undefined) {
            return this[enableMethod](userName);
          }
        })
        .then(res => {
          go();
        })
        .catch(err => {
          return reject(err);
        });
    });
  },

  async findUser(userName, opts) {
    userName = String(userName || '');
    return new Promise(async (resolve, reject) => {
      let attributes;
      if (opts && (opts.fields || opts.attributes)){
        attributes = opts.fields || opts.attributes;
      }else{
        let cached = this._cache.get('users', userName);
        if (cached) {
          return resolve(api.processResults(opts, [cached])[0]);
        }
      }

      const domain = this.config.domain;
      userName = userName.indexOf('@') > -1 ? userName.split('@')[0] : userName;
      const filter = `(|(userPrincipalName=${userName}@${domain})(sAMAccountName=${userName}))`;
      const params = {
        filter,
        includeMembership: ['all'],
        includeDeleted: false
      };
      
      if (attributes){
        params.attributes = attributes;
      }
      
      this.ad.find(params, (err, results) => {
        if (err) {
          /* istanbul ignore next */
          return reject(err);
        }
        if (!results || !results.users || results.users.length < 1) {
          this._cache.set('users', userName, {});
          return resolve({});
        }
        this._cache.set('users', userName, results.users[0]);
        results.users = api.processResults(opts, results.users);
        return resolve(results.users[0]);
      });
    });
  },

  async userExists(userName) {
    return new Promise(async (resolve, reject) => {
      const domain = this.config.domain;
      let fullUser = `${userName}@${domain}`;
      this.ad.userExists(fullUser, (error, exists) => {
        if (error) {
          /* istanbul ignore next */
          return reject(error);
        }
        return resolve(exists);
      });
    });
  },

  async userIsMemberOf(userName, groupName) {
    return new Promise(async (resolve, reject) => {
      let userDN;
      this.findUser(userName)
        .then(userObject => {
          userDN = userObject.dn;
          return this._getGroupUsers(groupName);
        })
        .then(users => {
          users = users.filter(u => u.dn === userDN);
          let exists = users.length > 0;
          resolve(exists);
        })
        .catch(err => {
          /* istanbul ignore next */
          reject(err);
        });
    });
  },

  async authenticateUser(userName, pass) {
    const domain = this.config.domain;
    let fullUser = `${userName}@${domain}`;
    return new Promise(async (resolve, reject) => {
      //console.log('AUTH USER', fullUser, pass);
      this.ad.authenticate(fullUser, pass, (error, authorized) => {
        let code;
        let out = authorized;
        //console.log('BACK FROM AUTH', error, authorized);
        if (error && error.lde_message) {
          out.detail = error.lde_message;
          out.message = String(error.stack).split(':')[0];
          error = undefined;
        }
        if (error) {
          /* istanbul ignore next */
          return reject(error);
        }
        return resolve(out);
      });
    });
  },

  async setUserPassword(userName, pass) {
    return new Promise((resolve, reject) => {
      if (!pass) {
        return reject({ message: 'No password provided.' });
      }
      this._userReplaceOperation(userName, {
        unicodePwd: encodePassword(pass)
      })
        .then(resolve)
        .catch(reject);
    });
  },

  async setUserCN(userName, cn) {
    return new Promise(async (resolve, reject) => {
      this.findUser(userName)
        .then(userObject => {
          let oldDN = userObject.dn;
          let parts = String(oldDN).split(',');
          parts.shift();
          parts.unshift(`CN=${cn}`);
          return this._modifyDN(oldDN, parts.join(','));
        })
        .then(result => {
          delete this._cache.users[userName];
          resolve(result);
        })
        .catch(err => {
          /* istanbul ignore next */
          reject(err);
        });
    });
  },

  async setUserProperty(userName, obj) {
    return this._userReplaceOperation(userName, obj);
  },

  async setUserProperties(userName, obj) {
    return this._userReplaceOperations(userName, obj);
  },

  async setUserPasswordNeverExpires(userName) {
    const NEVER_EXPIRES = 66048;
    return this._userReplaceOperation(userName, {
      userAccountControl: NEVER_EXPIRES
    });
  },

  async enableUser(userName) {
    const ENABLED = 512;
    return this._userReplaceOperation(userName, {
      userAccountControl: ENABLED
    });
  },

  async disableUser(userName) {
    const DISABLED = 514;
    return this._userReplaceOperation(userName, {
      userAccountControl: DISABLED
    });
  },

  async moveUser(userName, location) {
    return new Promise(async (resolve, reject) => {
      location = parseLocation(location);
      this.findUser(userName)
        .then(userObject => {
          let oldDN = userObject.dn;
          let baseDN = String(this.config.baseDN).replace(/dc=/g, 'DC=');
          let newDN = `CN=${userObject.cn},${location}${baseDN}`;
          return this._modifyDN(oldDN, newDN);
        })
        .then(result => {
          delete this._cache.users[userName];
          resolve(result);
        })
        .catch(err => {
          /* istanbul ignore next */
          reject(err);
        });
    });
  },

  async getUserLocation(userName) {
    return new Promise(async (resolve, reject) => {
      this.findUser(userName)
        .then(userObject => {
          if (Object.keys(userObject).length < 1) {
            /* istanbul ignore next */
            return reject({ error: true, message: 'User does not exist.' });
          }
          let dn = userObject.dn;
          let left = String(dn)
            .replace(/DC=/g, 'dc=')
            .replace(/CN=/g, 'cn=')
            .replace(/OU=/g, 'ou=')
            .split(',dc=')[0];
          let location = String(left)
            .split(',')
            .slice(1)
            .reverse()
            .join('/')
            .replace(/cn=/g, '!')
            .replace(/ou=/g, '');
          return resolve(location);
        })
        .catch(err => {
          /* istanbul ignore next */
          return reject(err);
        });
    });
  },

  async unlockUser(userName) {
    return this._userReplaceOperation(userName, {
      lockoutTime: 0
    });
  },

  async removeUser(userName) {
    return new Promise(async (resolve, reject) => {
      this.findUser(userName).then(userObject => {
        if (Object.keys(userObject).length < 1) {
          return reject({ error: true, message: 'User does not exist.' });
        }
        this._deleteObjectByDN(userObject.dn)
          .then(resp => {
            resolve(resp);
          })
          .catch(err => {
            /* istanbul ignore next */
            reject(Object.assign(err, { error: true }));
          });
      });
    });
  }
};
