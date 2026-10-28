import net from "node:net";
import crypto from "node:crypto";
import { buildCommand } from "./tslib/index.js";

// Uploads an image as the bot's own avatar: ftinitupload → TCP (ftkey + bytes) → clientupdate.
export function uploadAvatar(client: any, host: string, img: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const md5 = crypto.createHash("md5").update(img).digest("hex");
    const clientftfid = Math.floor(Math.random() * 100000) + 1;

    const done = (err?: Error) => {
      clearTimeout(timer);
      client.removeListener("command", onCmd);
      client.removeListener("ts3error", onErr);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => done(new Error("ftinitupload timeout")), 10000);

    const onCmd = (p: any) => {
      const q = p?.params || {};
      if (q.ftkey && q.port) {
        client.removeListener("command", onCmd);
        transfer(q.ftkey, Number(q.port));
      }
    };
    const onErr = (p: any) => {
      if (p?.id && p.id !== "0") done(new Error(`ts3 ${p.id}: ${p.msg || ""}`));
    };
    client.on("command", onCmd);
    client.on("ts3error", onErr);

    client.sendCommand(
      buildCommand("ftinitupload", {
        clientftfid,
        name: "/avatar",
        cid: 0,
        cpw: "",
        size: img.length,
        overwrite: 1,
        resume: 0,
        proto: 0,
      }),
    );

    function transfer(ftkey: string, port: number) {
      const sock = net.connect(port, host, () => {
        sock.write(Buffer.from(ftkey, "latin1"));
        sock.write(img);
        sock.end();
      });
      sock.on("error", (e) => done(e));
      sock.on("close", () => {
        // register the avatar in the client flag (md5 hash) so others can download it
        client.sendCommand(buildCommand("clientupdate", { client_flag_avatar: md5 }));
        done();
      });
    }
  });
}
