type User = {
  id: number;
  name: string;
  admin?: boolean;
};

// Database has three users: 'root', 'john' and 'jane' (ids 1,2,3)
const users: User[] = [
  { id: 0, name: "root", admin: true },
  { id: 1, name: "John" },
  { id: 2, name: "Jane" },
  { id: 3, name: "Patrick" },
];

export default class UsersController {
  // Helper method to find a user by name
  find(name: string) {
    return users.find((u) => u.name === name);
  }

  // DELETE /users/:id
  delete_$id(id = -1) {
    const i = users.findIndex((u) => u.id === id);
    if (i == -1) throw new Deno.errors.NotFound();
    users.splice(i, 1);
    return { id, status: "deleted" };
  }

  // GET /users
  get(sort = false) {
    const fn = (a: User, b: User) => sort ? a.name.localeCompare(b.name) : 1;
    return users.filter((u) => !u.admin).toSorted(fn);
  }

  // GET /users/admins
  get_admins($user: string) {
    // Requires authenticated admin user to proceed
    const admin = this.find($user)?.admin;
    if (!admin) throw new Deno.errors.PermissionDenied();
    return users.filter((u) => u.admin);
  }

  // GET /users/multiple
  // WARNING: WILL ONLY WORK WITH TYPES!
  get_multiple(ids: number[]) {
    return users.filter((u) => ids.includes(u.id));
  }

  // GET /users/:id
  get_$id(id = -1) {
    const user = users.find((u) => u.id === id);
    if (!user) throw new Deno.errors.NotFound();
    return user;
  }

  // GET /users/:id/async
  get_$id_async(id = -1): Promise<User> {
    // return new Promise((ok, fail) => setTimeout(() => fail(new Deno.errors.NotSupported("Huh?")), 100));
    return new Promise((ok, fail) =>
      setTimeout(() => {
        const user = users.find((u) => u.id === id);
        if (user) ok(user);
        else fail(new Deno.errors.NotFound());
      }, 20)
    );
  }

  // HEAD /users
  head() {
    return { thisWillNot: "beSent" };
  }

  // PATCH /users/:id
  patch_$id(id = -1, $body: Partial<User>) {
    const user = users.find((u) => u.id === id);
    if (!user) throw new Deno.errors.NotFound();
    Object.assign(user, $body);
    return { id, status: "patched" };
  }

  // POST /users
  post($body: User) {
    let user = users.find((u) => u.id === $body.id);
    if (user) throw new Deno.errors.AlreadyExists();
    user = $body;
    const ids = users.map((u) => u.id);
    if (!user.id) user.id = Math.max(...ids) + 1;
    users.push(user);
    return { id: user.id, status: "posted" };
  }

  // PUT /users/:id
  put_$id(id = 1, $body: User) {
    const user = users.find((u) => u.id === id);
    if (!user) throw new Deno.errors.NotFound();
    Object.assign(user, $body);
    return { id, status: "put" };
  }

  // GET /users/:id/avatar.png
  get_$id_avatar_$_png(id = -1) {
    if (!users.find((u) => u.id === id)) throw new Deno.errors.NotFound();
    // deno-fmt-ignore
    const png = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAABZSURBVDhPYxgFtAXsQNwHxPOAmB8kQCpIB+JlQAwypA0kQCrQB+J7UOwOEiAV2APxaSC+DcT+IAFSAMj/74DYHIjVgfgaEINcRDQAafyPhsOBeBRQHzAwAACMiw6sN2ANVQAAAABJRU5ErkJggg==";
    return atob(png);
  }

  // GET /users/pgp
  get_pgp() {
    const pgp = "-----BEGIN PGP MESSAGE----- ... -----END PGP MESSAGE-----";
    return new Response(pgp, { headers: { "Content-Type": "application/pgp-encrypted" } });
  }

  // GET /users/policy
  get_policy() {
    return Response.redirect("https://meta.wikimedia.org/wiki/Privacy_policy");
  }
}
