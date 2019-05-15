import Color = cc.Color;
import * as pomelo from "./pomelo/pomelo-client";

const {ccclass, property} = cc._decorator;

@ccclass
export default class Helloworld extends cc.Component {

    @property(cc.ScrollView)
    view: cc.ScrollView = null;

    @property(cc.EditBox)
    edit: cc.EditBox = null;

    @property(cc.EditBox)
    nameEdit: cc.EditBox = null;

    @property(cc.EditBox)
    roomEdit: cc.EditBox = null;

    _userName:string  = "";
    start () {

    }

    addMsg2View(msg:string,from:string){
        let node = new cc.Node();
        let label = node.addComponent(cc.Label);
        label.string = `${from}:`+msg;
        label.fontSize = 30;
        node.color = Color.BLACK;
        node.setAnchorPoint(0,0.5);
        node.x = -this.view.content.width/2;
        this.view.content.addChild(node);
        this.view.scrollToBottom(0.2);
    }

    onSend(){
        if(!this.nameEdit.string || !this.roomEdit.string || !this.edit.string){
            return;
        }
        let context = this.edit.string;
        let sendRoute="chat.chatHandler.send";
        pomelo.request(sendRoute,{content: context,from: this._userName, target:"*"},(data)=>{
            cc.log(JSON.stringify(data));
            console.log("发送成功了");
            console.log("chat :" + data.msg);
        });
        this.edit.string = "";
    }

    onClear(){
        this.view.content.removeAllChildren();
    }

    onLogin(){
        let name = this.nameEdit.string;
        let room = this.roomEdit.string;
        if(!name ||!room){
            cc.log("edit your name or room id");
            return;
        }
        pomelo.on('disconnect', function(reason) {
            console.log("pomelo.on() disconnect: ", reason);
        });
        let host ="192.168.0.8";// "127.0.0.1";
        let port = "3014";
        let gateRoute = 'gate.gateHandler.queryEntry';
        let rid= room || "1";
        let uid=name+"*"+rid;
        this._userName = name;
        //请求链接gate服务器
        pomelo.init({
            host: host,
            port: port,
            log: true
        }, ()=>{
            //连接成功之后，向gate服务器请求ip和port
            pomelo.request(gateRoute,{
                uid: uid
            }, (data)=>{
                //断开与gate服务器之间的连接
                pomelo.disconnect();
                //使用gate服务器返回的ip和port请求链接connector服务器
                pomelo.init({
                    host: host,
                    port: data.port,
                    log: true
                },()=>{
                    //连接成功之后，向connector服务器发送登陆请求
                    let connRoute="connector.entryHandler.enter";
                    pomelo.request(connRoute,{username: name, rid:rid},(data)=>{
                        cc.log(JSON.stringify(data));
                        console.log(`${name},登陆成功啦`);
                    })
                });
            });

            pomelo.on('onChat', (data)=>{
                console.log(data.from, data.target, data.msg);
                this.addMsg2View(data.msg,data.from);
            });
        });
    }

    onLogout(){

    }
}