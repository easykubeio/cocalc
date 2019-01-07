/*
SyncTable server channel -- used for supporting realtime sync
between project and browser client.

TODO:

- [ ] If initial query fails, need to raise exception.  Right now it gets
silently swallowed in persistent mode...
*/

import { reuseInFlight } from "async-await-utils/hof";

import {
  synctable_no_changefeed,
  synctable_no_database,
  SyncTable
} from "../smc-util/sync/table";

import { init_syncdoc } from "./sync-doc";

import { register_synctable } from "./open-synctables";

import { once } from "../smc-util/async-utils";

const { is_array, deep_copy, len } = require("../smc-util/misc2");

type Query = { [key: string]: any };

interface Spark {
  address: { ip: string };
  id: string;
  write: (string) => void;
  on: (string, Function) => void;
}

interface Channel {
  on: (string, Function) => void;
  forEach: (Function) => void;
  destroy: Function;
}

import { Client } from "../smc-util/sync/editor/generic/types";

interface Primus {
  channel: (string) => Channel;
}

interface Logger {
  debug: Function;
}

import * as stringify from "fast-json-stable-stringify";
const { sha1 } = require("smc-util-node/misc_node");

class SyncTableChannel {
  private synctable: SyncTable;
  private client: Client;
  private logger: Logger;
  public readonly name: string;
  private query: Query;
  private options: any[] = [];
  private query_string: string;
  private channel: Channel;
  private closed: boolean = false;

  // If true, do not use a database at all, even on the backend.
  // Table is reset any time this object is created.  This is
  // useful, e.g., for tracking user cursor locations or other
  // ephemeral state.
  private ephemeral: boolean = false;

  // If true, do not close even if all clients have disconnected.
  // This is used to keep sessions running, even when all browsers
  // have closed, e.g., state for Sage worksheets, jupyter
  // notebooks, etc., where user may want to close their browser
  // (or just drop a connection temporarily) while a persistent stateful
  // session continues running.
  private persistent: boolean = false;

  constructor({
    client,
    primus,
    query,
    options,
    logger,
    name
  }: {
    client: Client;
    primus: Primus;
    name: string;
    query: Query;
    options: any;
    logger: Logger;
  }) {
    this.name = name;
    this.client = client;
    this.logger = logger;
    this.query = query;
    this.init_options(options);
    this.query_string = stringify(query); // used only for logging
    this.channel = primus.channel(this.name);
    this.log(
      `creating new sync channel (persistent=${this.persistent}, ephemeral=${
        this.ephemeral
      })`
    );
  }

  public async init(): Promise<void> {
    this.init_handlers();
    return await this.init_synctable();
  }

  private init_options(options): void {
    if (options == null) {
      return;
    }
    for (let option of deep_copy(options)) {
      // deep_copy so do not mutate input options.
      if (typeof option != "object" || option == null) {
        throw Error("invalid options");
      }
      for (let x of ["ephemeral", "persistent"]) {
        // options that are only for project websocket tables.
        if (option[x] != null) {
          this[x] = option[x];
          delete option[x];
        }
      }
      if (len(option) > 0) {
        // remaining synctable/database options.
        this.options.push(option);
      }
    }
  }

  private log(...args): void {
    if (this.closed) return;
    this.logger.debug(
      `SyncTableChannel('${this.name}', '${this.query_string}'): `,
      ...args
    );
  }

  private init_handlers(): void {
    this.log("init_handlers");
    this.channel.on("connection", this.new_connection.bind(this));
  }

  private async init_synctable(): Promise<void> {
    this.log("init_synctable");
    let create_synctable: Function;
    if (this.ephemeral) {
      this.log("init_synctable -- ephemeral (no database)");
      create_synctable = synctable_no_database;
    } else {
      this.log("init_synctable -- persistent (but no changefeeds)");
      create_synctable = synctable_no_changefeed;
    }
    this.synctable = create_synctable(this.query, this.options, this.client);

    // if the synctable closes, then the channel should also close.
    this.synctable.once("closed", this.close.bind(this));

    if (this.query[this.synctable.table][0].string_id != null) {
      register_synctable(this.query, this.synctable);
    }
    if (this.synctable.table === "syncstrings") {
      this.log("init_synctable -- syncstrings: also initialize syncdoc...");
      init_syncdoc(this.client, this.synctable, this.logger);
    }
    this.synctable.on("saved-objects", this.handle_synctable_save.bind(this));
    this.log("created synctable -- waiting for connected state");
    await once(this.synctable, "connected");
    this.log("created synctable -- now connected");
    // broadcast synctable content to all connected clients.
    this.broadcast_synctable_all();
  }

  private new_connection(spark: Spark): void {
    // Now handle the connection
    this.log(`new connection from ${spark.address.ip} -- ${spark.id}`);
    this.send_synctable_all(spark);

    spark.on("data", async data => {
      try {
        await this.handle_data(spark, data);
      } catch (err) {
        spark.write({ error: `error handling command -- ${err}` });
        this.log("error handling command -- ", err, err.stack);
      }
    });

    spark.on("close", () => {
      this.log(
        `spark event -- close connection ${spark.address.ip} -- ${spark.id}`
      );
      this.check_if_should_close();
    });
    spark.on("end", () => {
      this.log(
        `spark event -- end connection ${spark.address.ip} -- ${spark.id}`
      );
      this.check_if_should_close();
    });
    spark.on("open", () => {
      this.log(
        `spark event -- open connection ${spark.address.ip} -- ${spark.id}`
      );
    });
  }

  private synctable_all(): any[] | undefined {
    const all = this.synctable.get();
    if (all === undefined) {
      return;
    }
    return all.valueSeq().toJS();
  }

  private send_synctable_all(spark: Spark): void {
    this.log("send_synctable_all");
    const new_val = this.synctable_all();
    if (new_val == null) {
      return;
    }
    spark.write({ new_val });
  }

  private broadcast_synctable_all(): void {
    this.log("broadcast_synctable_all");
    const new_val = this.synctable_all();
    if (new_val == null) {
      return;
    }
    this.channel.forEach((spark: Spark) => {
      spark.write({ new_val });
    });
  }

  private handle_synctable_save(saved_objs): void {
    if (saved_objs.length === 0) {
      return;
    }
    let n = 0;
    this.channel.forEach((spark: Spark) => {
      n += 1;
      spark.write({ new_val: saved_objs });
    });
    this.log(`handle_synctable_save -- wrote data to ${n} sparks`);
  }

  /* Check if we should close, e.g., due to no connected clients. */
  private check_if_should_close(): void {
    if (this.closed || this.persistent) {
      // don't bother if either already closed, or the persistent option is set.
      return;
    }
    let n = 0;
    this.channel.forEach((spark: Spark) => {
      console.log(`existing connection ${spark.id}`);
      n += 1;
    });
    if (n === 0) {
      this.log("check_if_should_close -- ", n, " closing");
      this.close();
    } else {
      this.log("check_if_should_close -- ", n, " do not close");
    }
  }

  private async handle_data(_: Spark, data: any): Promise<void> {
    this.log("handle_data ", (this.channel as any).channel, data);
    if (!is_array(data)) {
      throw Error("data must be an array of set objects");
    }
    for (let new_val of data) {
      // We use set instead of "this.synctable.synthetic_change({new_val}, true);"
      // so these changes get saved to the database.
      // When the backend is also making changes, we
      // may need to be very careful...
      this.synctable.set(new_val, "shallow");
    }
    await this.synctable.save();
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    delete synctable_channels[this.name];
    this.channel.destroy();
    delete this.channel;
    delete this.client;
    delete this.logger;
    delete this.query;
    delete this.query_string;
    delete this.options;
    await this.synctable.close();
    delete this.synctable;
  }

}

const synctable_channels: { [name: string]: SyncTableChannel } = {};

function createKey(args): string {
  return stringify([args[3], args[4]]);
}

function channel_name(query: any, options:any[]): string {
  // stable identifier to this query + options across
  // project restart, etc.   We first make the options
  // as canonical as we can:
  const opts = {};
  for (let x of options) {
    for(let key in x) {
      opts[key] = x[key];
    }
  }
  const y = stringify([query, opts]);
  const s = sha1(y);
  return `sync:${s}`;
}

async function synctable_channel0(
  client: any,
  primus: any,
  logger: any,
  query: any,
  options: any[]
): Promise<string> {
  const name = channel_name(query, options);
  logger.debug("synctable_channel", query, name);
  if (synctable_channels[name] === undefined) {
    synctable_channels[name] = new SyncTableChannel({
      client,
      primus,
      name,
      query,
      options,
      logger
    });
    await synctable_channels[name].init();
  }
  return name;
}

export const synctable_channel = reuseInFlight(synctable_channel0, { createKey });
