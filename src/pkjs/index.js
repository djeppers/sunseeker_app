Pebble.addEventListener('ready', function() {
    getLocation();
});

Pebble.addEventListener('appmessage', function() {
    getLocation();
});

function getLocation() {
    navigator.geolocation.getCurrentPosition(
        function(pos) {
            Pebble.sendAppMessage({
                lat: Math.round(pos.coords.latitude * 10000),
                lon: Math.round(pos.coords.longitude * 10000)
            });
        },
        function(err) {
            console.log('Location error: ' + err.message);
        },
        { enableHighAccuracy: true, maximumAge: 300000, timeout: 15000 }
    );
}
