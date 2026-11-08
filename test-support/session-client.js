import {randomBytes} from 'node:crypto';
export function sessionClient(base) {
 let cookie='',csrf='',user=null;const credentials={username:'u_'+randomBytes(10).toString('hex'),password:randomBytes(24).toString('base64url'),displayName:'시연 사용자'};
 return {
  credentials,
  get cookie(){return cookie},get csrf(){return csrf},get user(){return user},
  async request(path,data,headers={}){const response=await fetch(base+path,{...(data===undefined?{}:{method:'POST',body:JSON.stringify(data)}),headers:{'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf,...headers}});if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];const body=await response.json();if(body.csrfToken)csrf=body.csrfToken;if(Object.hasOwn(body,'user'))user=body.user;return{status:response.status,body,headers:response.headers}},
  async bootstrap(){return this.request('/api/auth/session')},
  async signup(){await this.bootstrap();return this.request('/api/auth/register',credentials)},
  async login(){return this.request('/api/auth/login',credentials)},
 };
}
