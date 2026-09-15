// Local-only disposable native PostgreSQL implementation of the SQL fixture
// interface. The PGlite export name is compatibility with existing launchers;
// backendKind and native connections distinguish the evidence explicitly.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';

const execute=promisify(execFile);
const runtime=process.env.MEM00_NATIVE_PG_RUNTIME;
assert(runtime && /^\/private\/tmp\/mem00-native-pg\.[A-Za-z0-9]+$/.test(runtime),'explicit disposable runtime required');
const {default:pg}=await import(pathToFileURL(process.env.MEM00_PG_CLIENT_MODULE || path.join(runtime,'node_modules/pg/lib/index.js')).href);
pg.types.setTypeParser(20,value=>{const number=Number(value);assert(Number.isSafeInteger(number));return number;});

export class PGlite {
  backendKind='native-postgres';
  connections=new Set();
  constructor(){this.ready=this.initialize();}
  async initialize(){
    this.directory=await mkdtemp('/private/tmp/mem00-pg-cluster.');
    this.data=path.join(this.directory,'data');
    this.binary=path.join(runtime,'node_modules/@embedded-postgres/darwin-arm64/native/bin');
    this.commandOptions={env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'},timeout:30000,maxBuffer:1048576};
    await execute(path.join(this.binary,'initdb'),['-D',this.data,'-A','trust','-U','mem00','--encoding=UTF8','--no-locale'],this.commandOptions);
    await execute(path.join(this.binary,'pg_ctl'),['-D',this.data,'-l',path.join(this.directory,'postgres.log'),'-w','-t','20',
      '-o',"-h '' -k "+this.directory+' -p 5432','start'],this.commandOptions);
    this.started=true;
    this.client=await this.openConnection();
    this.backendVersion=(await this.client.query('show server_version')).rows[0].server_version;
  }
  async openConnection(){
    const client=new pg.Client({host:this.directory,port:5432,user:'mem00',database:'postgres',connectionTimeoutMillis:5000});
    this.connections.add(client);
    client.once('end',()=>this.connections.delete(client));
    await client.connect();
    await client.query("set statement_timeout='10s'");
    return client;
  }
  async connectIndependent(){await this.ready;return this.openConnection();}
  async restart(){
    await this.ready;
    for(const client of [...this.connections])await client.end();
    await execute(path.join(this.binary,'pg_ctl'),['-D',this.data,'-l',path.join(this.directory,'postgres.log'),'-m','fast','-w','-t','20','restart'],this.commandOptions);
    this.client=await this.openConnection();
  }
  async exec(sql){await this.ready;return this.client.query(sql);}
  async query(sql,args=[]){await this.ready;return this.client.query(sql,args);}
  async close(){
    try{await this.ready;}catch{/* Startup failure still owns its exact fixture. */}
    for(const client of this.connections)await client.end();
    if(this.binary && this.data){
      let live=this.started;
      if(!live){
        try{await execute(path.join(this.binary,'pg_ctl'),['-D',this.data,'status'],this.commandOptions);live=true;}
        catch(error){if(![3,4].includes(error.code))throw error;}
      }
      if(live)await execute(path.join(this.binary,'pg_ctl'),['-D',this.data,'-m','fast','-w','-t','20','stop'],this.commandOptions);
    }
    // Only the directory issued by mkdtemp above; no user/database path input.
    if(this.directory){assert(/^\/private\/tmp\/mem00-pg-cluster\.[A-Za-z0-9]+$/.test(this.directory));await rm(this.directory,{recursive:true,force:false});}
  }
}
