var drone = {
	pitchSpeed: 15, rollSpeed: 15, yawSpeed: 60, 
	flySpeed: 18, calibrated: false,
	pidPitchSetPoint: 0, pidRollSetPoint: 0,
	motorSpeed: [0,0,0,0], pidValues: [0,0,0,0]
}; 
var settingsBackup, calibrationBackup, bayeuxCli, netClient, io;

var j5 = require("johnny-five"),
	net = require('net'),
	firmata = require('firmata'),
	IMU_Helper = require("./IMU_Helper").Helper;
	commandServerModule = require("./CommandServer").Server,
	PID = require("./PID").PID;
	//API = require("./API").API;

function attachHardware() {
	drone.IMU = IMU_Helper.getIMU(j5);

	drone.pitchMotors = [];
	drone.rollMotors = [];

	/*      PITCH axis
			
		   	  (6) Front
				 ||
	Left   (3)----------(5) Right  ROLL axis
			     ||
	   	      (9) Rear

	*/

	//Left-Right
	drone.rollMotors.push( new j5.Motor({ pin: 3 }) );	
	drone.rollMotors.push( new j5.Motor({ pin: 5 }) );

	//Front-Rear
	drone.pitchMotors.push( new j5.Motor({ pin: 6 }) );
	drone.pitchMotors.push( new j5.Motor({ pin: 9 }) );

	drone.rollMotors[0].motorId = 0;
	drone.pitchMotors[0].motorId = 1;
	drone.rollMotors[1].motorId = 2;
	drone.pitchMotors[1].motorId = 3;

	drone.yawMotors = drone.rollMotors.concat(drone.pitchMotors);
};

function initDrone() {
	drone.PID = [];
	attachHardware();
	drone.PID.push( new PID("PITCH", drone.pidPitchSetPoint, 5, 2, 4) );
	drone.PID.push( new PID("ROLL", drone.pidRollSetPoint, 5, 2, 4) );	
	drone.PID.push( new PID("YAW", 0, 3, 2, 3) );	
	IMU_Helper.startIMU(onIMUCallback);
	//drone.API = new API();
	//drone.API.createAPIServer(drone);
};

function onIMUCallback(data, cancelCallback) {
	var pitchSpeed = drone.PID[0].compute(data, drone.pidPitchSetPoint);
	var rollSpeed = drone.PID[1].compute(data, drone.pidRollSetPoint);	

	drone.pidValues[0] = !data.xReverse ? Math.abs(rollSpeed) : -Math.abs(rollSpeed);
	drone.pidValues[2] = !data.xReverse ? -Math.abs(rollSpeed) : Math.abs(rollSpeed);

	drone.pidValues[1] = !data.yReverse ? -Math.abs(pitchSpeed) : Math.abs(pitchSpeed);
	drone.pidValues[3] = !data.yReverse ? Math.abs(pitchSpeed) : -Math.abs(pitchSpeed);

	adjustMotors();
	if (drone.isWakeUp) {
		applySpeeds();
	}

	bayeuxCli.publish("/j5_imu", data);
};

function adjustMotors() {	
	drone.motorSpeed[0] += drone.pidValues[0];
	drone.motorSpeed[1] += drone.pidValues[1];
	drone.motorSpeed[2] += drone.pidValues[2];
	drone.motorSpeed[3] += drone.pidValues[3];
};
function fixMotorLimits() {
	drone.motorSpeed[0] = drone.motorSpeed[0] > 240 ? 240 : drone.motorSpeed[0];
	drone.motorSpeed[1] = drone.motorSpeed[1] > 240 ? 240 : drone.motorSpeed[1];
	drone.motorSpeed[2] = drone.motorSpeed[2] > 240 ? 240 : drone.motorSpeed[2];
	drone.motorSpeed[3] = drone.motorSpeed[3] > 240 ? 240 : drone.motorSpeed[3];

	drone.motorSpeed[0] = drone.motorSpeed[0] < 60 ? 60 : drone.motorSpeed[0];
	drone.motorSpeed[1] = drone.motorSpeed[1] < 60 ? 60 : drone.motorSpeed[1];
	drone.motorSpeed[2] = drone.motorSpeed[2] < 60 ? 60 : drone.motorSpeed[2];
	drone.motorSpeed[3] = drone.motorSpeed[3] < 60 ? 60 : drone.motorSpeed[3];
};
function applySpeeds() {
	fixMotorLimits();
	drone.rollMotors[0].fwd(drone.motorSpeed[0]);
	drone.pitchMotors[0].fwd(drone.motorSpeed[1]);
	drone.rollMotors[1].fwd(drone.motorSpeed[2]);
	drone.pitchMotors[1].fwd(drone.motorSpeed[3]);
	bayeuxCli.publish("/j5_motorSpeed", drone.motorSpeed);
};

function onWakeUp() {
	drone.motorSpeed = [0, 0, 0, 0];
	drone.yawMotors.forEach(function(motor) {
		motor.start(drone.yawSpeed);
		drone.motorSpeed[motor.motorId] = drone.yawSpeed;
	});
	drone.isWakeUp = true;
	bayeuxCli.publish("/j5_motorSpeed", drone.motorSpeed);
};

function onFlyUp() {
	drone.isWakeUp = true;
	for (var i=0; i < drone.motorSpeed.length; i++) {
		drone.motorSpeed[i] += drone.flySpeed;
	}	
	//applySpeeds();

	/*
		var leftVel = drone.yawSpeed - 2;
		var upVel = drone.yawSpeed;
		var rightVel = drone.yawSpeed - 60;
		var downVel = drone.yawSpeed - 20;

		leftVel = leftVel < 0 ? 0 : leftVel;
		upVel = upVel < 0 ? 0 : upVel;
		rightVel = rightVel < 0 ? 0 : rightVel;
		downVel = downVel < 0 ? 0 : downVel;

		drone.rollMotors[0].fwd(leftVel);
		drone.pitchMotors[0].fwd(upVel);
		drone.rollMotors[1].fwd(rightVel);
		drone.pitchMotors[1].fwd(downVel);	

		drone.motorSpeed[drone.rollMotors[0].motorId] = leftVel;
		drone.motorSpeed[drone.pitchMotors[0].motorId] = upVel;
		drone.motorSpeed[drone.rollMotors[1].motorId] = rightVel;
		drone.motorSpeed[drone.pitchMotors[1].motorId] = downVel;
	*/
};
function onFlyDown() {
	drone.isWakeUp = false;
	drone.pidRollSetPoint = 0;
	drone.pidPitchSetPoint = 0;
	
	drone.yawSpeed -= drone.flySpeed * 6;
	drone.yawMotors.forEach(function(motor) {
		if (drone.yawSpeed <= 0) {
			drone.yawSpeed = 0;
		}
		drone.motorSpeed[motor.motorId] = drone.yawSpeed;
		motor.fwd(drone.yawSpeed);
	});
	bayeuxCli.publish("/j5_motorSpeed", drone.motorSpeed);
};

function onRotateRight() {
	/*
		var leftMotor = drone.rollMotors[0];
		var rightMotor = drone.rollMotors[1];
		var Lspeed = leftMotor.currentSpeed + drone.pitchSpeed;
		var Rspeed = rightMotor.currentSpeed - drone.pitchSpeed;
		Lspeed = (Lspeed >= 255 ? 255 : Lspeed);
		Rspeed = (Rspeed >= 255 ? 255 : Rspeed);
		Lspeed = (Lspeed <= 0 ? 0 : Lspeed);
		Rspeed = (Rspeed <= 0 ? 0 : Rspeed);
		drone.motorSpeed[leftMotor.motorId] = Lspeed;
		drone.motorSpeed[rightMotor.motorId] = Rspeed;
		leftMotor.fwd(Lspeed);
		rightMotor.fwd(Rspeed);
	*/
	drone.pidRollSetPoint -= 2;
	if (drone.pidRollSetPoint < -30) {
		drone.pidRollSetPoint = -30;
	}
	//applySpeeds();
};
function onRotateLeft() {
	drone.pidRollSetPoint += 2;
	if (drone.pidRollSetPoint > 30) {
		drone.pidRollSetPoint = 30;
	}
};

function onForward() {
	drone.pidPitchSetPoint += 2;
	if (drone.pidPitchSetPoint > 30) {
		drone.pidPitchSetPoint = 30;
	}	
};
function onBackward() {
	drone.pidPitchSetPoint -= 2;
	if (drone.pidPitchSetPoint < -30) {
		drone.pidPitchSetPoint = -30;
	}
};

function onSelfLeft() {
	var leftMotor = drone.yawMotors[0];
	var rightMotor = drone.yawMotors[1];

	var frontMotor = drone.rollMotors[0];
	var rearMotor = drone.rollMotors[1];

	var Lspeed = leftMotor.currentSpeed + drone.pitchSpeed;
	var Rspeed = rightMotor.currentSpeed - drone.pitchSpeed;

	Lspeed = (Lspeed >= 255 ? 255 : Lspeed);
	Rspeed = (Rspeed >= 255 ? 255 : Rspeed);

	Lspeed = (Lspeed <= 0 ? 0 : Lspeed);
	Rspeed = (Rspeed <= 0 ? 0 : Rspeed);

	leftMotor.fwd(Lspeed);
	rightMotor.fwd(Rspeed);

	frontMotor.fwd(Lspeed);
	rearMotor.fwd(Rspeed);
	bayeuxCli.publish("/j5_motorSpeed", drone.motorSpeed);
};
function onSelfRight() {
	var leftMotor = drone.yawMotors[0];
	var rightMotor = drone.yawMotors[1];

	var frontMotor = drone.rollMotors[0];
	var rearMotor = drone.rollMotors[1];

	var Lspeed = leftMotor.currentSpeed - drone.pitchSpeed;
	var Rspeed = rightMotor.currentSpeed + drone.pitchSpeed;

	Lspeed = (Lspeed >= 255 ? 255 : Lspeed);
	Rspeed = (Rspeed >= 255 ? 255 : Rspeed);

	Lspeed = (Lspeed <= 0 ? 0 : Lspeed);
	Rspeed = (Rspeed <= 0 ? 0 : Rspeed);

	leftMotor.fwd(Lspeed);
	rightMotor.fwd(Rspeed);

	frontMotor.fwd(Lspeed);
	rearMotor.fwd(Rspeed);
	bayeuxCli.publish("/j5_motorSpeed", drone.motorSpeed);
};

function getSettings() { return settingsBackup; };
function getRotation() { return drone.rotation; };
function idle() { drone.pidPitchSetPoint = 0; drone.pidRollSetPoint = 0; };

function setSettings(data) {
	drone.pitchSpeed = data.pitch || drone.pitchSpeed; drone.rollSpeed = data.roll || drone.rollSpeed; drone.yawSpeed = data.yaw || drone.yawSpeed;
};

function emergencyLand() {
	console.warn("Something goes wrong! Doing emergency land");
};

function create(BT_PORT) {
	bayeuxCli = commandServerModule.startFayeServer(me);
	board = new j5.Board({ port: BT_PORT });
	board.on("ready", initDrone);
};

function createWifi(options) {
	options = options || { host: '192.168.4.1', port: 23 };
	netClient = net.connect(options, onNetClientConnect);
	function onNetClientConnect() {
		console.log('Net Client connection successfully');  
		var socketClient = this;
		io = new firmata.Board(socketClient);
		io.once('ready', onIOReady);
	}
	function onIOReady() {
		console.log('Net IO Ready');
		io.isReady = true;
		board = new j5.Board({io: io, repl: true});		
		board.on('ready', initDrone);
	}
};

var me = {
	create: create,
	createWifi: createWifi,
	getSettings: getSettings,
	setSettings: setSettings,
	getRotation: getRotation,

	emergencyLand: emergencyLand,

	wakeUp: onWakeUp,
	flyUp: onFlyUp,
	flyDown: onFlyDown,
	rotateLeft: onRotateLeft,
	rotateRight: onRotateRight,
	selfRight: onSelfRight,
	selfLeft: onSelfLeft,
	backward: onBackward,
	forward: onForward,
	idle: idle
};	
exports.Drone = me;