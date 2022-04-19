import * as THREE from 'https://unpkg.com/three@0.127.0/build/three.module.js';

import { OrbitControls } from 'https://unpkg.com/three@0.127.0/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'https://unpkg.com/three@0.127.0/examples/jsm/loaders/GLTFLoader.js'
import { VRButton } from 'https://unpkg.com/three@0.127.0/examples/jsm/webxr/VRButton.js'
import { LineMaterial } from 'https://unpkg.com/three@0.127.0/examples/jsm/lines/LineMaterial.js'
import { Line2 } from 'https://unpkg.com/three@0.127.0/examples/jsm/lines/Line2.js'
import { LineGeometry } from 'https://unpkg.com/three@0.127.0/examples/jsm/lines/LineGeometry.js'

THREE.Object3D.DefaultUp = new THREE.Vector3(0,0,1);

class TesseractViewer {

    constructor()
    {
        this._scene = null;
        this._clock = null;
        this._camera = null;
        this._renderer = null;
        this._light = null;
        this._scene_etag = null;
        this._watch_etags = new Map();
        this._watch_disable_updates = new Map();
        this._animation_mixer = null;
        this._animation = null;
        this._animation_action = null;
        this._root_z_up = null;
        this._root_env = null;
        this._xr_start = null;

    }

    async createScene() {
        this._scene = new THREE.Scene();
        this._clock = new THREE.Clock();

        const camera = new THREE.PerspectiveCamera( 45, window.innerWidth/window.innerHeight, 0.1, 1000 );
        camera.position.x = 3;
        camera.position.y = 1.5;
        camera.position.z = 3;
        this._camera = camera;

        const renderer = new THREE.WebGLRenderer( { antialias: true } );
        renderer.setPixelRatio( window.devicePixelRatio );
        renderer.setSize( window.innerWidth, window.innerHeight );
        renderer.outputEncoding = THREE.sRGBEncoding;
        renderer.xr.enabled = true;

        renderer.setClearColor("#000000");

        this._renderer = renderer;


        window.addEventListener( 'resize', onWindowResize, false );

        let xr_start = new THREE.Object3D();
        xr_start.translateX(2);
        xr_start.lookAt(10,0,0);
        this._xr_start = xr_start
        this._scene.add(xr_start);

        function onWindowResize(){

            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();

            renderer.setSize( window.innerWidth, window.innerHeight );
        }

        const light = new THREE.HemisphereLight( 0xffffbb, 0x202018, 1 );
        this._scene.add( light );
        this._light = light;

        document.body.appendChild( renderer.domElement );

        const controls = new OrbitControls( camera, renderer.domElement );

        let _this = this;
        document.body.appendChild( VRButton.createButton( renderer ) );
        
        renderer.xr.addEventListener('sessionstart', function () {
            _this._xr_start.add(camera);
        });

        renderer.xr.addEventListener('sessionend', function() {
            if(camera.parent) {                
                let parent = camera.parent;
                camera.parent.remove(camera);
                
                setTimeout(function () {
                    controls.reset();                       
                }
                , 100);
                
            }
        });

        renderer.setAnimationLoop( this.render.bind(this) );

        const gridHelper = new THREE.GridHelper( 10, 10 );
        gridHelper.rotateX(Math.PI / 2);
        this._scene.add( gridHelper );

        const root_z_up = new THREE.Object3D();
        //root_z_up.rotateX(-Math.PI / 2.0);
        this._scene.add(root_z_up);

        const root_env = new THREE.Object3D();
        root_z_up.add(root_env);

        this._root_z_up = root_z_up;
        this._root_env = root_env;

        this._animation_mixer = new THREE.AnimationMixer( this._root_env );

        await this.updateScene();
        this.watchSceneFile();

        const queryString = window.location.search;
        const urlParams = new URLSearchParams(queryString);
        let do_update = true;
        if (urlParams.has("noupdate")) {
            if (urlParams.get("noupdate") === "true") {
                do_update = false;
            }
        }
        if (do_update) {
            setTimeout(() => _this.watchTrajectoryFile(), 0);
            setTimeout(() => _this.watchTcpTrajectoryFile(), 0);
        }

    }

    render() {
        // Render the scene
        this._renderer.render(this._scene, this._camera);

        var delta = this._clock.getDelta();
        if ( this._animation_mixer ) this._animation_mixer.update( delta );
    };

    async watchSceneFile() {
        let _this = this;
        this.beginWatchFileEtag("tesseract_scene.gltf", 1000, () => _this.updateScene())
    }

    async updateScene() {
        
        const loader = new GLTFLoader();

        let gltf = await new Promise((resolve, reject) => {
            loader.load('tesseract_scene.gltf', data=> resolve(data), null, reject);
        });

        if (this._root_env)
        {
            for( var i = this._root_env.children.length - 1; i >= 0; i--) { 
                let obj = this._root_env.children[i];
                this._root_env.remove(obj); 
            }
        }

        this._root_env.add(gltf.scene);        

        if (gltf.animations.length > 0)
        {
            
            this._animation_mixer.stopAllAction();
            this._animation_mixer.uncacheRoot(this._root_env);
             
            let animation_action = this._animation_mixer.clipAction(gltf.animations[0]);
            animation_action.play();

            this._animation = gltf.animations[0];
            this._animation_action = animation_action;
        }
    }

    async fetchEtag(filename) {
        let fetch_res;
        try {
            fetch_res = await fetch(filename, { method: "HEAD" });
        }
        catch (_a) {
            return null;
        }
        if (!fetch_res.ok) {            
            return null;
        }
        let etag = fetch_res.headers.get('etag');
        return etag;
    }

    async fetchJson(filename)
    {
        let response = await fetch(filename);
        return await response.json();
    }

    beginWatchFileEtag(filename, period, handler)
    {
        if (this._watch_disable_updates.get(filename) === true)
        {
            return;
        }

        this._doWatchFileEtag(filename, period, handler);
    }

    disableWatchFileEtag(filename)
    {
        this._watch_disable_updates.set(filename, true);
    }

    enableWatchFileEtag(filename)
    {
        this._watch_disable_updates.set(filename, false);
    }

    async _doWatchFileEtag(filename, period, handler)
    {
        if (this._watch_disable_updates.get(filename) === true)
        {
            return;
        }

        let _this = this;

        let etag = await this.fetchEtag(filename);
        let last_etag = this._watch_etags.get(filename)
        if (etag == null || last_etag === etag) {
            console.log("No update for " + filename);
            setTimeout(() => _this._doWatchFileEtag(filename, period, handler), period);
            return;
        }

        setTimeout(() => handler(), 0);

        if (etag != null) {
            this._watch_etags.set(filename, etag);
            setTimeout(() => _this._doWatchFileEtag(filename, period, handler), period);
        }
    }

    async updateTrajectory() {
        try {
            let trajectory_json = await this.fetchJson("./tesseract_trajectory.json");
            this.setTrajectory(trajectory_json.joint_names, trajectory_json.trajectory);
        }
        catch (e) {
            console.log("Trajectory not available");
            console.log(e);
        }
    }
    watchTrajectoryFile() {
        
        let _this = this;

        this.beginWatchFileEtag("./tesseract_trajectory.json", 1000, () => _this.updateTrajectory())
        
    }
    disableWatchTrajectory() {
        this.disableWatchFileEtag("./tesseract_trajectory.json")
        this.disableWatchFileEtag("./tesseract_tcp_trajectory.json")
    }
    enableWatchTrajectory() {
        this.enableWatchFileEtag("./tesseract_trajectory.json")
        this.enableWatchFileEtag("./tesseract_tcp_trajectory.json")
    }
    setJointPositions(joint_names, joint_positions) {
        let trajectory = [[...joint_positions, 0], [...joint_positions, 100000]];
        this.setTrajectory(joint_names, trajectory);
    }

    setTrajectory(joint_names, trajectory) {
        
        this._animation_mixer.stopAllAction();
        this._animation_mixer.uncacheRoot(this._root_env);

        let anim = this.trajectoryToAnimation(joint_names, trajectory);
        let animation_action = this._animation_mixer.clipAction(anim);
        animation_action.play();

        this._animation = anim;
        this._animation_action = animation_action;
    }

    trajectoryToAnimation(joint_names, trajectory) {
        let joints = this.findJoints(joint_names);
        let tracks = []
        joint_names.forEach((joint_name, joint_index) => {
            let joint = joints[joint_name];
            switch (joint.type) {
                case 1:
                    {
                        let values = [];
                        let times = []
                        trajectory.forEach(ee => {
                            let axis_vec = new THREE.Vector3().fromArray(joint.axes);
                            let quat = new THREE.Quaternion().setFromAxisAngle(axis_vec, ee[joint_index]);
                            let quat_array = quat.toArray();
                            values.push(...quat_array);
                            times.push(ee[ee.length - 1])
                        });
                        let track = new THREE.QuaternionKeyframeTrack(joint.joint.name + ".quaternion", times, values);                    
                        tracks.push(track);
                    }
                    break;
                case 2:
                    {
                        let values = [];
                        let times = []
                        trajectory.forEach(ee => {
                            let axis_vec = new THREE.Vector3().fromArray(joint.axes);
                            let vec = axis_vec.multiplyScalar(ee[joint_index]);
                            let vec_array = vec.toArray();
                            values.push(...vec_array);
                            times.push(ee[ee.length - 1])
                        });
                        let track = new THREE.VectorKeyframeTrack(joint.joint.name + ".position", times, values);                    
                        tracks.push(track);
                    }
                    break;
                default:
                    throw new Error("Unknown joint type");
            }
        });

        let animation_clip = new THREE.AnimationClip("tesseract_trajectory", -1, tracks);

        return animation_clip;
    }

    findJoints(joint_names)
    {
        let ret = {}
        this._root_env.traverse(tf => {
            if (tf.userData && tf.userData["tesseract_joint"])
            {
                let t_j = tf.userData["tesseract_joint"];

                if (joint_names && joint_names.indexOf(t_j["name"]) == -1) {
                    return;
                }
                let t = {};
                t.joint_name = t_j["name"];
                t.node_name = tf.name;
                t.joint = tf;
                t.axes = t_j.axis;
                t.type = t_j.type;
                ret[t.joint_name] = t;
            }
        });
        return ret;
    }

    async updateTcpTrajectory() {
        try {
            let tcp_trajectory_json = await this.fetchJson("./tesseract_tcp_trajectory.json");
            this.setTcpTrajectory(tcp_trajectory_json);
        }
        catch (e) {
            console.log("Trajectory not available");
            console.log(e);
        }
    }
    watchTcpTrajectoryFile() {
        
        let _this = this;

        this.beginWatchFileEtag("./tesseract_tcp_trajectory.json", 1000, () => _this.updateTcpTrajectory())
        
    }

    setTcpTrajectory(tcp_trajectory_json) {

        let display_obj = this._scene.getObjectByName("tesseract_tcp_trajectory_display");
        if (display_obj) {
            display_obj.parent.remove(display_obj);
        }

        let traj_json = tcp_trajectory_json.tcp_trajectory;
        if (!traj_json || traj_json.length === 0) {
            return;
        }

        let points = [];
        traj_json.forEach(p => points = points.concat(p.position));
        const geometry = new LineGeometry();
        geometry.setPositions(points);

        const material = new LineMaterial( { 
            color: 0x00ff00,
            linewidth: 0.005,
            // resolution: new THREE.Vector2(640, 480)
        } );

        const line = new Line2( geometry, material );
        line.computeLineDistances();
		line.scale.set( 1, 1, 1 );
        line.name="tesseract_tcp_trajectory_display";

        this._root_z_up.add(line);

    }
}

window.addEventListener("DOMContentLoaded", async function () {
    let viewer = new TesseractViewer();
    window.tesseract_viewer = viewer;
    await viewer.createScene();
    window.addEventListener("message", function (event) {
        let data = event.data;
        if (data.command === "joint_positions") {
            viewer.disableUpdateTrajectory();
            viewer.setJointPositions(data.joint_names, data.joint_positions);
        }
        if (data.command === "joint_trajectory") {
            viewer.disableUpdateTrajectory();
            viewer.setTrajectory(data.joint_names, data.joint_trajectory);
        }
        if (data.command === "joint_tcp_trajectory") {
            viewer.disableUpdateTrajectory();
            viewer.setTcpTrajectory(data.tcp_trajectory);
        }
    });
    viewer.render();
})