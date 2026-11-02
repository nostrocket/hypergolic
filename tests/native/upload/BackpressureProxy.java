package org.nostrocket.hypergolic.proof;

import java.io.FileOutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

/** Test-only transparent TCP hop. No TLS termination, HTTP parsing or fabricated replies. */
public final class BackpressureProxy {
  public static void main(String[] args) throws Exception {
    int listening = Integer.parseInt(args[0]), upstream = Integer.parseInt(args[1]);
    try (ServerSocket listener = new ServerSocket()) {
      listener.setReceiveBufferSize(8192);
      listener.bind(new java.net.InetSocketAddress("127.0.0.1", listening));
      try (var file = new FileOutputStream("/data/local/tmp/hg-upload-proxy.pid")) {
        file.write(Integer.toString(android.os.Process.myPid()).getBytes(StandardCharsets.US_ASCII));
      }
      System.out.println("READY transparent rate-limited TCP " + listening + " -> " + upstream);
      while (true) {
        Socket client = listener.accept();client.setReceiveBufferSize(8192);
        Thread operation = new Thread(() -> {
          try (client; Socket server = new Socket("127.0.0.1", upstream)) {
            Thread response = new Thread(() -> {
              try {server.getInputStream().transferTo(client.getOutputStream());client.shutdownOutput();}
              catch (Exception ignored) { /* A revoked native peer closes this connection. */ }
            });
            response.setDaemon(true);response.start();
            byte[] buffer = new byte[8192];int length;
            while ((length = client.getInputStream().read(buffer)) >= 0) {
              Thread.sleep(40);server.getOutputStream().write(buffer, 0, length);
            }
            server.shutdownOutput();response.join(80000);
          } catch (Exception ignored) { /* Current native stop or provider close. */ }
        });operation.setDaemon(true);operation.start();
      }
    }
  }
}
